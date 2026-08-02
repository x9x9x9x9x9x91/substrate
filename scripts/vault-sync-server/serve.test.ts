import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { syncMirror } from "./mirror.ts";
import { createVaultSyncServer } from "./serve.ts";

const execFileAsync = promisify(execFile);

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectListen(new Error("HTTPS server did not expose a TCP address"));
        return;
      }
      resolveListen(address.port);
    });
  });
}

function getStatus(url: string, authorization?: string): Promise<{ status: number; authenticate?: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpsRequest(url, {
      method: "GET",
      rejectUnauthorized: false,
      headers: authorization ? { Authorization: authorization } : undefined,
    }, (response) => {
      response.resume();
      response.once("end", () => resolveRequest({
        status: response.statusCode ?? 0,
        authenticate: response.headers["www-authenticate"],
      }));
    });
    request.once("error", rejectRequest);
    request.end();
  });
}

async function generateCertificate(directory: string): Promise<{ cert: string; key: string }> {
  const cert = join(directory, "server-cert.pem");
  const key = join(directory, "server-key.pem");
  const config = join(directory, "openssl.cnf");
  await writeFile(config, [
    "[req]",
    "distinguished_name = dn",
    "x509_extensions = v3_req",
    "prompt = no",
    "[dn]",
    "CN = localhost",
    "[v3_req]",
    "subjectAltName = @alt_names",
    "[alt_names]",
    "DNS.1 = localhost",
    "IP.1 = 127.0.0.1",
    "",
  ].join("\n"), { mode: 0o600 });
  await execFileAsync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1",
    "-keyout", key, "-out", cert, "-config", config,
  ], { maxBuffer: 10 * 1024 * 1024 });
  return { cert, key };
}

test("authenticated HTTPS mirror supports clone, chunked binary push, and rejection", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "substrate-vault-sync-server-test-"));
  let runningServer: Server | undefined;
  t.after(async () => {
    if (runningServer?.listening) await closeServer(runningServer);
    await rm(root, { recursive: true, force: true });
  });

  const working = join(root, "working-vault");
  const mirror = join(root, "vault.git");
  const clone = join(root, "phone-clone");
  const tokenFile = join(root, "sync-token");
  const token = "test-token-368";
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  const { cert, key } = await generateCertificate(root);

  await git(["init", "-q", "-b", "main", working]);
  await git(["-C", working, "config", "user.name", "Substrate Test"]);
  await git(["-C", working, "config", "user.email", "test@substrate.invalid"]);
  await writeFile(join(working, "vault-note.md"), "first version\n");
  await git(["-C", working, "add", "vault-note.md"]);
  await git(["-C", working, "commit", "-q", "-m", "first vault commit"]);

  assert.equal(await syncMirror({ source: working, mirror }), "created");
  await writeFile(join(working, "vault-note.md"), "second version\n");
  await git(["-C", working, "commit", "-q", "-am", "refresh vault commit"]);
  assert.equal(await syncMirror({ source: working, mirror }), "refreshed");

  const created = await createVaultSyncServer({ repo: mirror, tokenFile, cert, key });
  runningServer = created.server;
  const port = await listen(created.server);
  const repoUrl = `https://127.0.0.1:${port}${created.urlPath}`;
  const bearerHeader = `Authorization: Bearer ${token}`;

  const missing = await getStatus(`${repoUrl}/info/refs?service=git-upload-pack`);
  assert.equal(missing.status, 401);
  assert.match(missing.authenticate ?? "", /^Basic\b/);
  const wrong = await getStatus(`${repoUrl}/info/refs?service=git-upload-pack`, "Bearer wrong-token");
  assert.equal(wrong.status, 401);
  await assert.rejects(git(["-c", "http.sslVerify=false", "ls-remote", repoUrl]));
  await assert.rejects(git([
    "-c", "http.sslVerify=false",
    "-c", "http.extraHeader=Authorization: Bearer wrong-token",
    "ls-remote", repoUrl,
  ]));

  const otherPath = await getStatus(
    `https://127.0.0.1:${port}/other.git/info/refs?service=git-upload-pack`,
    `Bearer ${token}`,
  );
  assert.equal(otherPath.status, 404);

  await git([
    "-c", "http.sslVerify=false",
    "-c", `http.extraHeader=${bearerHeader}`,
    "clone", "-q", repoUrl, clone,
  ]);
  assert.equal(await readFile(join(clone, "vault-note.md"), "utf8"), "second version\n");

  const basic = Buffer.from(`ignored-username:${token}`, "utf8").toString("base64");
  const refs = await git([
    "-c", "http.sslVerify=false",
    "-c", `http.extraHeader=Authorization: Basic ${basic}`,
    "ls-remote", repoUrl, "refs/heads/main",
  ]);
  assert.match(refs, /refs\/heads\/main$/);

  await git(["-C", clone, "config", "user.name", "Phone Test"]);
  await git(["-C", clone, "config", "user.email", "phone@substrate.invalid"]);
  const binaryBytes = randomBytes(128 * 1024);
  await writeFile(join(clone, "phone.bin"), binaryBytes);
  await git(["-C", clone, "add", "phone.bin"]);
  await git(["-C", clone, "commit", "-q", "-m", "phone commit"]);
  // A tiny postBuffer forces Git's smart-HTTP client onto chunked transfer;
  // the random pack payload also catches accidental string coercion.
  await git([
    "-c", "http.sslVerify=false",
    "-c", `http.extraHeader=${bearerHeader}`,
    "-c", "http.postBuffer=1024",
    "-C", clone, "push", "-q", "origin", "HEAD:main",
  ]);

  assert.equal(
    await git(["--git-dir", mirror, "rev-parse", "refs/heads/main"]),
    await git(["-C", clone, "rev-parse", "HEAD"]),
  );
  assert.equal(await git(["--git-dir", mirror, "cat-file", "-s", "main:phone.bin"]), String(binaryBytes.length));
});
