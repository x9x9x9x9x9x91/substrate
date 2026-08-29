#!/usr/bin/env node
/**
 * Wire capture for the auto-sync verification lane — the half of
 * `scripts/autosync-verify.sh` that reads bytes off the socket.
 *
 * The lane's older ciphertext proof greps the sync server's storage directory.
 * That is real evidence, but it is the SERVER's word: the store writes request
 * bodies to disk verbatim, so anything that leaked in a header, in a URL, or on
 * a route the store never persists would walk straight past it. This sits
 * between the app and the store instead — a plain TCP tee on the loopback
 * address the app dials — and keeps every byte in both directions. The
 * assertion then runs over the capture, outside both processes.
 *
 * Nothing here decrypts or intercepts TLS. Loopback hosted sync is plain HTTP
 * by design (a `blob+http://` remote is refused for anything but a loopback
 * address), so the bytes in the capture are the bytes the app wrote, read the
 * way a packet sniffer on the same machine would read them.
 *
 * Two modes, both driven by the shell script:
 *
 *     node scripts/autosync-verify.ts proxy \
 *       --listen 8791 --upstream 127.0.0.1:8792 --dir <capture> --ready <file>
 *
 *     node scripts/autosync-verify.ts assert --dir <capture> \
 *       --forbid <phrase> [--forbid <phrase> …] [--forbid-file <path>]
 *
 * `assert` fails the run on the first thing it cannot vouch for: a forbidden
 * phrase anywhere in either direction, a body whose envelope magic is not the
 * one that route's payload must carry, a response that arrived encoded, or a
 * request shape it cannot read. An unreadable request is thrown rather than
 * skipped — a skipped request is exactly the one a leak would ride.
 */
import { createServer, connect, type Socket } from "node:net";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* ── the envelope framing, per route ─────────────────────────────────────── */

/**
 * Which four bytes every body on a given route must open with. The client
 * seals object payloads, the ref document and the wrapped master key with
 * three different envelope headers (`OBJECT_MAGIC`, `REF_MAGIC`, `WRAP_MAGIC`
 * in `src-tauri/src/gitsync/blob.rs`), and those are the only three routes it
 * ever sends a body on. A body on any other route is a shape this lane has
 * never seen and will not vouch for.
 */
export const BODY_RULES: { route: RegExp; magic: string; noun: string }[] = [
  { route: /\/objects\/[^/?]+$/, magic: "SBO1", noun: "object" },
  { route: /\/ref$/, magic: "SBR1", noun: "ref" },
  { route: /\/key$/, magic: "SBK1", noun: "key" },
];

export type WireRequest = {
  method: string;
  target: string;
  bodyLength: number;
  /** First four body bytes as latin1, or `""` for a bodiless request. */
  magic: string;
};

/* ── reading requests back out of a raw byte stream ──────────────────────── */

/**
 * Split one connection's client→server bytes into requests.
 *
 * The transport speaks HTTP/1.1 with an explicit `Content-Length` on every
 * body it sends, so framing is that header and nothing else; a chunked body
 * would be a transport change this reader has not been taught, and it says so
 * instead of guessing. A capture can legitimately end mid-request — the proxy
 * is torn down while a keep-alive connection is still open — so trailing bytes
 * that do not complete a request are reported, not thrown.
 */
export function splitRequests(
  raw: Buffer,
  label = "capture",
): { requests: WireRequest[]; trailing: number } {
  const requests: WireRequest[] = [];
  let at = 0;
  while (at < raw.length) {
    const headEnd = raw.indexOf("\r\n\r\n", at, "latin1");
    if (headEnd < 0) break;
    const lines = raw.toString("latin1", at, headEnd).split("\r\n");
    const start = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? "");
    if (!start) {
      throw new Error(`${label}: unreadable request line ${JSON.stringify(lines[0] ?? "")}`);
    }
    const headers = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon < 0) throw new Error(`${label}: unreadable header ${JSON.stringify(line)}`);
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    if (headers.has("transfer-encoding")) {
      throw new Error(`${label}: a chunked body is a framing this capture cannot read`);
    }
    // A compressed body is still ciphertext under the envelope, but the scan
    // below reads raw bytes: anything the client squeezed would be unreadable
    // to it and would pass for free. Loud, not skipped.
    if (headers.has("content-encoding")) {
      throw new Error(`${label}: an encoded request body is a framing this capture cannot read`);
    }
    const declared = headers.get("content-length") ?? "0";
    if (!/^\d+$/.test(declared)) {
      throw new Error(`${label}: unreadable content-length ${JSON.stringify(declared)}`);
    }
    const bodyLength = Number(declared);
    const bodyStart = headEnd + 4;
    if (bodyStart + bodyLength > raw.length) break; // cut mid-body at teardown
    requests.push({
      method: start[1],
      target: start[2],
      bodyLength,
      magic: bodyLength > 0 ? raw.toString("latin1", bodyStart, bodyStart + 4) : "",
    });
    at = bodyStart + bodyLength;
  }
  return { requests, trailing: raw.length - at };
}

/** Every body must be an envelope, and the envelope its route's payload uses. */
export function auditBodies(requests: WireRequest[]): string[] {
  const problems: string[] = [];
  for (const request of requests) {
    if (request.bodyLength === 0) continue;
    const rule = BODY_RULES.find((candidate) => candidate.route.test(request.target.split("?")[0]!));
    if (!rule) {
      problems.push(`${request.method} ${request.target} carried a body on a route with no envelope rule`);
      continue;
    }
    if (request.magic !== rule.magic) {
      problems.push(
        `${request.method} ${request.target} opened with ${JSON.stringify(request.magic)}, ` +
          `not the ${rule.noun} envelope ${rule.magic}`,
      );
    }
  }
  return problems;
}

/**
 * Responses must arrive unencoded, for the same reason requests must: the scan
 * reads raw bytes, so a gzipped response body would hide whatever it carried
 * and read as clean. The store never sets the header today — this is the guard
 * that says so if it ever starts.
 */
export function auditResponses(captures: { name: string; raw: Buffer }[]): string[] {
  const problems: string[] = [];
  for (const { name, raw } of captures) {
    if (!name.endsWith(".res")) continue;
    const match = /\r\ncontent-encoding[ \t]*:([^\r\n]*)/i.exec(raw.toString("latin1"));
    if (match) {
      problems.push(`${name}: a response arrived with Content-Encoding:${match[1]}`);
    }
  }
  return problems;
}

/**
 * Every occurrence of a phrase that must never cross the wire, named by file
 * and offset. Searched over the raw bytes rather than over parsed bodies on
 * purpose: a request line, a header or a response is as much "the wire" as a
 * payload is, and a leak is likelier in the parts nobody encrypts.
 */
export function scanForbidden(
  captures: { name: string; raw: Buffer }[],
  forbidden: string[],
): string[] {
  const hits: string[] = [];
  // The needle is the phrase's UTF-8 bytes, which is what a leak of it would
  // look like on the wire. Handing the string straight to indexOf would search
  // its latin1 bytes instead, and every phrase carrying an em dash, a curly
  // apostrophe or an ellipsis would then be unfindable by construction.
  const needles = forbidden.map((phrase) => ({ phrase, bytes: Buffer.from(phrase, "utf8") }));
  for (const { name, raw } of captures) {
    for (const { phrase, bytes } of needles) {
      let at = raw.indexOf(bytes);
      while (at >= 0) {
        hits.push(`${name}@${at}: ${JSON.stringify(phrase)}`);
        at = raw.indexOf(bytes, at + 1);
      }
    }
  }
  return hits;
}

/* ── argument parsing ────────────────────────────────────────────────────── */

export type Options = {
  mode: "proxy" | "assert";
  listen: number;
  upstreamHost: string;
  upstreamPort: number;
  dir: string;
  ready: string;
  forbid: string[];
};

export function parseArgs(argv: string[]): Options {
  const mode = argv[0];
  if (mode !== "proxy" && mode !== "assert") {
    throw new Error(`usage: autosync-verify.ts <proxy|assert> …, got ${JSON.stringify(mode ?? "")}`);
  }
  const options: Options = {
    mode,
    listen: 0,
    upstreamHost: "127.0.0.1",
    upstreamPort: 0,
    dir: "",
    ready: "",
    forbid: [],
  };
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i += 1;
    switch (flag) {
      case "--listen":
        options.listen = port(value, flag);
        break;
      case "--upstream": {
        const split = value.lastIndexOf(":");
        if (split < 1) throw new Error(`--upstream wants host:port, got ${JSON.stringify(value)}`);
        options.upstreamHost = value.slice(0, split);
        options.upstreamPort = port(value.slice(split + 1), flag);
        break;
      }
      case "--dir":
        options.dir = value;
        break;
      case "--ready":
        options.ready = value;
        break;
      case "--forbid":
        // An empty phrase would match everywhere and read as a leak in every
        // run; an unset shell variable is the way it would arrive.
        if (value === "") throw new Error("--forbid needs a non-empty phrase");
        options.forbid.push(value);
        break;
      case "--forbid-file": {
        // One phrase per line. The seeded vault contributes hundreds of them —
        // every line of prose it holds, its note names, its folder names, its
        // tags — which is more than an argv should carry. The file is written
        // by the run, not by hand, so there are no comments in it: a line
        // opening with `#` is a markdown heading the vault really holds, and
        // treating it as a comment would quietly excuse it from the scan.
        const lines = readFileSync(value, "utf8").split("\n");
        let taken = 0;
        for (const line of lines) {
          const phrase = line.replace(/\r$/, "");
          if (phrase === "") continue;
          options.forbid.push(phrase);
          taken += 1;
        }
        if (taken === 0) throw new Error(`--forbid-file ${JSON.stringify(value)} held no phrases`);
        break;
      }
      default:
        throw new Error(`unknown flag ${JSON.stringify(flag)}`);
    }
  }
  if (!options.dir) throw new Error("--dir is required");
  if (mode === "proxy" && (!options.listen || !options.upstreamPort)) {
    throw new Error("proxy needs --listen and --upstream");
  }
  return options;
}

function port(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} wants a port number, got ${JSON.stringify(value)}`);
  const parsed = Number(value);
  if (parsed < 1 || parsed > 65535) throw new Error(`${flag} is out of range: ${value}`);
  return parsed;
}

/* ── the tee ─────────────────────────────────────────────────────────────── */

function runProxy(options: Options): void {
  mkdirSync(options.dir, { recursive: true });
  let seq = 0;
  const server = createServer((client: Socket) => {
    seq += 1;
    const id = String(seq).padStart(3, "0");
    // Appended synchronously, not through a write stream: the tee is killed
    // from the script the moment the app is done, and a buffered stream would
    // take the last bytes of the run — the interesting ones — down with it.
    const requestLog = openSync(join(options.dir, `c${id}.req`), "a");
    const responseLog = openSync(join(options.dir, `c${id}.res`), "a");
    const upstream = connect(options.upstreamPort, options.upstreamHost);
    client.on("data", (chunk: Buffer) => writeSync(requestLog, chunk));
    upstream.on("data", (chunk: Buffer) => writeSync(responseLog, chunk));
    client.pipe(upstream);
    upstream.pipe(client);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      client.destroy();
      upstream.destroy();
      closeSync(requestLog);
      closeSync(responseLog);
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
  });
  server.listen(options.listen, "127.0.0.1", () => {
    if (options.ready) writeFileSync(options.ready, `${process.pid}\n`);
    console.log(`wire tee: 127.0.0.1:${options.listen} → ${options.upstreamHost}:${options.upstreamPort}`);
  });
}

/* ── the assertion ───────────────────────────────────────────────────────── */

function runAssert(options: Options): void {
  const names = readdirSync(options.dir)
    .filter((name) => name.endsWith(".req") || name.endsWith(".res"))
    .sort();
  if (names.length === 0) {
    console.error("WIRE FAIL: the capture is empty — nothing crossed the tee");
    process.exit(1);
  }
  const captures = names.map((name) => ({ name, raw: readFileSync(join(options.dir, name)) }));

  const requests: WireRequest[] = [];
  let trailing = 0;
  for (const capture of captures) {
    if (!capture.name.endsWith(".req")) continue;
    const read = splitRequests(capture.raw, capture.name);
    requests.push(...read.requests);
    trailing += read.trailing;
  }

  // The shell hands the same phrase in more than once when a seeded line is
  // also a note's title; scanning it twice would double-count every hit.
  const forbidden = [...new Set(options.forbid)];
  const leaks = scanForbidden(captures, forbidden);
  const badBodies = auditBodies(requests);
  const badResponses = auditResponses(captures);
  const bodies = requests.filter((request) => request.bodyLength > 0);
  const bytes = captures.reduce((total, capture) => total + capture.raw.length, 0);
  const report = {
    connections: names.filter((name) => name.endsWith(".req")).length,
    bytes,
    requests: requests.length,
    bodies: bodies.length,
    magics: Object.fromEntries(
      BODY_RULES.map((rule) => [rule.magic, bodies.filter((body) => body.magic === rule.magic).length]),
    ),
    forbidden: forbidden.length,
    leaks,
    badBodies,
    badResponses,
    trailing,
  };
  writeFileSync(join(options.dir, "wire-report.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log(`  ${report.connections} connection(s), ${bytes} bytes, ${requests.length} request(s)`);
  console.log(
    `  ${bodies.length} bodied request(s): ` +
      BODY_RULES.map((rule) => `${report.magics[rule.magic]} ${rule.noun}`).join(", "),
  );
  if (trailing > 0) console.log(`  ${trailing} trailing byte(s) — a connection cut at teardown`);
  if (bodies.length === 0) {
    console.error("WIRE FAIL: nothing was ever uploaded — a capture with no body proves nothing");
    process.exit(1);
  }
  if (badBodies.length > 0) {
    console.error(`WIRE FAIL: ${badBodies.length} body/bodies were not the route's envelope:`);
    for (const problem of badBodies) console.error(`    ${problem}`);
    process.exit(1);
  }
  if (badResponses.length > 0) {
    console.error(`WIRE FAIL: ${badResponses.length} encoded response(s) — the scan reads raw bytes:`);
    for (const problem of badResponses) console.error(`    ${problem}`);
    process.exit(1);
  }
  if (leaks.length > 0) {
    console.error(`WIRE FAIL: ${leaks.length} plaintext hit(s) on the wire:`);
    for (const hit of leaks) console.error(`    ${hit}`);
    process.exit(1);
  }
  console.log(`  ok   none of the ${forbidden.length} plaintext phrase(s) appear anywhere in the capture`);
  console.log("  ok   every uploaded body opened with its route's encryption envelope");
  console.log("  ok   every captured response arrived unencoded");
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "proxy") runProxy(options);
  else runAssert(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
