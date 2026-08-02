#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_CGI_HEADER_BYTES = 64 * 1024;

export interface VaultSyncServerOptions {
  repo: string;
  tokenFile: string;
  cert: string;
  key: string;
}

export interface VaultSyncCliOptions extends VaultSyncServerOptions {
  bind: string;
  port: number;
}

export interface CreatedVaultSyncServer {
  server: Server;
  repoPath: string;
  urlPath: string;
}

interface AuthorizedIdentity {
  remoteUser: string;
}

interface RequestRoute {
  pathInfo: string;
  queryString: string;
}

interface BodySource {
  stream: Readable;
  contentLength?: string;
  cleanup: () => Promise<void>;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function readSingleLineToken(contents: string): string {
  const withoutFinalNewline = contents.endsWith("\r\n")
    ? contents.slice(0, -2)
    : contents.endsWith("\n")
      ? contents.slice(0, -1)
      : contents;

  if (!withoutFinalNewline || withoutFinalNewline.includes("\n") || withoutFinalNewline.includes("\r")) {
    throw new Error("token file must contain exactly one non-empty line");
  }
  return withoutFinalNewline;
}

function authorize(header: string | undefined, tokenDigest: Buffer): AuthorizedIdentity | undefined {
  if (!header) return undefined;

  const bearer = header.match(/^Bearer[ \t]+(.+)$/i);
  if (bearer) {
    return timingSafeEqual(digest(bearer[1]), tokenDigest)
      ? { remoteUser: "substrate" }
      : undefined;
  }

  const basic = header.match(/^Basic[ \t]+([A-Za-z0-9+/]+={0,2})$/i);
  if (!basic) return undefined;

  let decoded: string;
  try {
    decoded = Buffer.from(basic[1], "base64").toString("utf8");
  } catch {
    return undefined;
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) return undefined;
  const username = decoded.slice(0, separator) || "substrate";
  const password = decoded.slice(separator + 1);
  return timingSafeEqual(digest(password), tokenDigest)
    ? { remoteUser: username }
    : undefined;
}

function routeRequest(requestUrl: string | undefined, urlPath: string): RequestRoute | undefined {
  let parsed: URL;
  let pathInfo: string;
  try {
    parsed = new URL(requestUrl ?? "/", "https://localhost");
    pathInfo = decodeURIComponent(parsed.pathname);
  } catch {
    return undefined;
  }

  const unsafeSegment = pathInfo.split("/").some((segment) => segment === "." || segment === "..");
  if (pathInfo.includes("\0") || unsafeSegment) return undefined;
  if (pathInfo !== urlPath && !pathInfo.startsWith(`${urlPath}/`)) return undefined;
  return { pathInfo, queryString: parsed.search.slice(1) };
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * CGI requires CONTENT_LENGTH, while an HTTP/1.1 client may stream a chunked
 * request without one. Node de-chunks those bytes for us; spool them to a
 * temporary file so their exact length can be supplied to git http-backend.
 * Buffers stay Buffers throughout, including compressed receive-pack bodies.
 */
async function prepareBody(request: IncomingMessage): Promise<BodySource> {
  const contentLength = headerValue(request.headers["content-length"]);
  if (contentLength) {
    if (!/^\d+$/.test(contentLength)) throw new Error("invalid Content-Length");
    return { stream: request, contentLength, cleanup: async () => undefined };
  }

  if (request.method !== "POST") {
    return { stream: request, cleanup: async () => undefined };
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "substrate-vault-sync-body-"));
  const bodyPath = join(temporaryDirectory, "request-body");
  let byteLength = 0;
  const counter = new Transform({
    transform(chunk: Buffer | string, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      byteLength += bytes.length;
      callback(null, bytes);
    },
  });

  try {
    await pipeline(request, counter, createWriteStream(bodyPath, { flags: "wx", mode: 0o600 }));
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    stream: createReadStream(bodyPath),
    contentLength: String(byteLength),
    cleanup: () => rm(temporaryDirectory, { recursive: true, force: true }),
  };
}

function findHeaderEnd(buffer: Buffer): { index: number; length: number } | undefined {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf < 0 && lf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function applyCgiHeaders(response: ServerResponse, rawHeaders: Buffer): void {
  const lines = rawHeaders.toString("latin1").split(/\r?\n/);
  let statusCode = 200;

  const httpStatus = lines[0]?.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/i);
  if (httpStatus) {
    statusCode = Number(httpStatus[1]);
    lines.shift();
  }

  const headers = new Map<string, { name: string; values: string[] }>();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error(`malformed CGI header: ${line}`);
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name.toLowerCase() === "status") {
      const status = value.match(/^(\d{3})(?:\s|$)/);
      if (!status) throw new Error(`malformed CGI status: ${value}`);
      statusCode = Number(status[1]);
      continue;
    }

    const lowerName = name.toLowerCase();
    if (lowerName === "connection" || lowerName === "transfer-encoding") continue;
    const existing = headers.get(lowerName);
    if (existing) existing.values.push(value);
    else headers.set(lowerName, { name, values: [value] });
  }

  response.statusCode = statusCode;
  for (const { name, values } of headers.values()) {
    response.setHeader(name, values.length === 1 ? values[0] : values);
  }
}

async function runGitBackend(
  request: IncomingMessage,
  response: ServerResponse,
  repoPath: string,
  route: RequestRoute,
  identity: AuthorizedIdentity,
  body: BodySource,
): Promise<void> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_PROJECT_ROOT: dirname(repoPath),
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: route.pathInfo,
    REMOTE_USER: identity.remoteUser,
    CONTENT_TYPE: headerValue(request.headers["content-type"]),
    QUERY_STRING: route.queryString,
    REQUEST_METHOD: request.method ?? "GET",
    REMOTE_ADDR: request.socket.remoteAddress ?? "",
    SERVER_PROTOCOL: `HTTP/${request.httpVersion}`,
    SERVER_NAME: headerValue(request.headers.host),
    SERVER_PORT: String(request.socket.localPort ?? ""),
  };
  if (body.contentLength !== undefined) environment.CONTENT_LENGTH = body.contentLength;
  const gitProtocol = headerValue(request.headers["git-protocol"]);
  if (gitProtocol) environment.HTTP_GIT_PROTOCOL = gitProtocol;

  await new Promise<void>((resolveBackend) => {
    const child = spawn("git", ["-c", "http.receivepack=true", "http-backend"], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let cgiHeaders = Buffer.alloc(0);
    let headersSent = false;
    let settled = false;
    let stderr = "";

    const settle = () => {
      if (settled) return;
      settled = true;
      resolveBackend();
    };

    const fail = (message: string) => {
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
        response.end("Git backend failed\n");
      } else if (!response.destroyed) {
        response.destroy();
      }
      console.error(`vault sync server: ${message}`);
    };

    body.stream.on("error", (error) => {
      child.stdin.destroy();
      child.kill();
      fail(`request body failed: ${error.message}`);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") console.error(`vault sync server: backend stdin failed: ${error.message}`);
    });
    body.stream.pipe(child.stdin);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 16 * 1024) stderr += chunk.slice(0, 16 * 1024 - stderr.length);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      if (headersSent) {
        if (!response.write(chunk)) {
          child.stdout.pause();
          response.once("drain", () => child.stdout.resume());
        }
        return;
      }

      cgiHeaders = Buffer.concat([cgiHeaders, chunk]);
      const end = findHeaderEnd(cgiHeaders);
      if (!end) {
        if (cgiHeaders.length > MAX_CGI_HEADER_BYTES) {
          child.kill();
          fail("CGI headers exceeded 64 KiB");
        }
        return;
      }

      try {
        applyCgiHeaders(response, cgiHeaders.subarray(0, end.index));
      } catch (error) {
        child.kill();
        fail(error instanceof Error ? error.message : String(error));
        return;
      }

      headersSent = true;
      response.flushHeaders();
      const bodyStart = end.index + end.length;
      if (bodyStart < cgiHeaders.length) response.write(cgiHeaders.subarray(bodyStart));
      cgiHeaders = Buffer.alloc(0);
    });

    child.once("error", (error) => {
      fail(`could not start git http-backend: ${error.message}`);
      settle();
    });

    child.once("close", (code, signal) => {
      if (!headersSent) {
        const detail = stderr.trim();
        fail(`git http-backend exited before CGI headers (code ${code}, signal ${signal})${detail ? `: ${detail}` : ""}`);
      } else if (!response.destroyed) {
        response.end();
      }
      if (code !== 0 && stderr.trim()) {
        console.error(`vault sync server: git http-backend stderr: ${stderr.trim()}`);
      }
      settle();
    });

    response.once("close", () => {
      if (!response.writableEnded) child.kill();
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  repoPath: string,
  urlPath: string,
  tokenDigest: Buffer,
): Promise<void> {
  const authorizationHeader = headerValue(request.headers.authorization);
  const identity = authorize(authorizationHeader, tokenDigest);
  if (!identity) {
    request.resume();
    response.writeHead(401, {
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": 'Basic realm="Substrate vault sync"',
    });
    response.end("Authentication required\n");
    return;
  }

  const route = routeRequest(request.url, urlPath);
  if (!route) {
    request.resume();
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }

  let body: BodySource;
  try {
    body = await prepareBody(request);
  } catch (error) {
    if (!response.destroyed) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Invalid request body\n");
    }
    console.error(`vault sync server: request body preparation failed: ${error instanceof Error ? error.message : error}`);
    return;
  }

  try {
    await runGitBackend(request, response, repoPath, route, identity, body);
  } finally {
    await body.cleanup();
  }
}

export async function createVaultSyncServer(options: VaultSyncServerOptions): Promise<CreatedVaultSyncServer> {
  const requestedRepo = resolve(options.repo);
  const repoPath = await realpath(requestedRepo);
  if (!(await stat(repoPath)).isDirectory()) throw new Error(`repo is not a directory: ${repoPath}`);

  const { stdout: bareOutput } = await execFileAsync(
    "git",
    ["-C", repoPath, "rev-parse", "--is-bare-repository"],
    { encoding: "utf8" },
  );
  if (bareOutput.trim() !== "true") {
    throw new Error(`server repo must be a bare Git repository: ${repoPath}`);
  }

  const [tokenContents, cert, key] = await Promise.all([
    readFile(resolve(options.tokenFile), "utf8"),
    readFile(resolve(options.cert)),
    readFile(resolve(options.key)),
  ]);
  const tokenDigest = digest(readSingleLineToken(tokenContents));
  const urlPath = `/${basename(repoPath)}`;

  const server = createServer({ cert, key }, (request, response) => {
    void handleRequest(request, response, repoPath, urlPath, tokenDigest).catch((error: unknown) => {
      console.error(`vault sync server: unhandled request error: ${error instanceof Error ? error.message : error}`);
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Internal server error\n");
      } else if (!response.destroyed) {
        response.destroy();
      }
    });
  });
  return { server, repoPath, urlPath };
}

export function parseServeArgs(argv: string[]): VaultSyncCliOptions {
  const options: VaultSyncCliOptions = {
    repo: "",
    tokenFile: "",
    cert: "",
    key: "",
    bind: "127.0.0.1",
    port: 7420,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${argument} needs a value`);
      index += 1;
      return next;
    };

    switch (argument) {
      case "--repo": options.repo = value(); break;
      case "--token-file": options.tokenFile = value(); break;
      case "--cert": options.cert = value(); break;
      case "--key": options.key = value(); break;
      case "--bind": options.bind = value(); break;
      case "--port": {
        const rawPort = value();
        const port = Number(rawPort);
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          throw new Error(`invalid --port: ${rawPort}`);
        }
        options.port = port;
        break;
      }
      case "--help":
      case "-h":
        console.log(
          "Usage: node serve.ts --repo <bare-repo> --token-file <path> --cert <pem> --key <pem> [--bind 127.0.0.1] [--port 7420]",
        );
        process.exit(0);
      // eslint-disable-next-line no-fallthrough -- the case above ends in process.exit()
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (!options.repo) throw new Error("missing required --repo <bare-repo>");
  if (!options.tokenFile) throw new Error("missing required --token-file <path>");
  if (!options.cert) throw new Error("missing required --cert <pem>");
  if (!options.key) throw new Error("missing required --key <pem>");
  return options;
}

async function main(): Promise<void> {
  const options = parseServeArgs(process.argv.slice(2));
  const { server, urlPath } = await createVaultSyncServer(options);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port, options.bind, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const displayHost = options.bind.includes(":") ? `[${options.bind}]` : options.bind;
  console.log(`vault sync server listening at https://${displayHost}:${port}${urlPath}`);

  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
