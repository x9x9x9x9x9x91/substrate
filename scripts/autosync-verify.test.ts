import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditBodies,
  auditResponses,
  parseArgs,
  scanForbidden,
  splitRequests,
  type WireRequest,
} from "./autosync-verify.ts";

const SCRIPT = join(import.meta.dirname, "autosync-verify.ts");

/** A capture directory written by hand, so the assertion can be aimed at one shape. */
function capture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "autosync-wire-fixed-"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), Buffer.from(body, "latin1"));
  }
  return dir;
}

const assertOn = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, "assert", "--dir", dir, ...args], { encoding: "utf8" });

/** One HTTP/1.1 request as the transport writes it, bytes and all. */
const wire = (method: string, target: string, body = ""): string =>
  `${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer t\r\n` +
  (body ? `Content-Length: ${body.length}\r\n` : "") +
  `\r\n${body}`;

const sealed = (magic: string, payload = "\x00\x91\xd4opaque") => `${magic}${payload}`;

/* ── argument parsing ───────────────────────────────────────────────────── */

test("parseArgs reads a proxy invocation", () => {
  const options = parseArgs(["proxy", "--listen", "8791", "--upstream", "127.0.0.1:8792", "--dir", "/tmp/w"]);
  assert.equal(options.mode, "proxy");
  assert.equal(options.listen, 8791);
  assert.equal(options.upstreamHost, "127.0.0.1");
  assert.equal(options.upstreamPort, 8792);
  assert.equal(options.dir, "/tmp/w");
});

test("parseArgs collects every forbidden phrase", () => {
  const options = parseArgs(["assert", "--dir", "/tmp/w", "--forbid", "one", "--forbid", "two"]);
  assert.deepEqual(options.forbid, ["one", "two"]);
});

test("parseArgs refuses an empty forbidden phrase", () => {
  // An unset shell variable arrives as "" and would match every run.
  assert.throws(() => parseArgs(["assert", "--dir", "/tmp/w", "--forbid", ""]), /non-empty/);
});

test("parseArgs refuses an unknown mode, an unknown flag and a missing dir", () => {
  assert.throws(() => parseArgs(["sniff", "--dir", "/tmp/w"]), /usage/);
  assert.throws(() => parseArgs(["assert", "--dir", "/tmp/w", "--quiet", "1"]), /unknown flag/);
  assert.throws(() => parseArgs(["assert"]), /--dir is required/);
});

test("parseArgs refuses a proxy without both ends, and a malformed upstream", () => {
  assert.throws(() => parseArgs(["proxy", "--listen", "8791", "--dir", "/tmp/w"]), /--listen and --upstream/);
  assert.throws(() => parseArgs(["proxy", "--upstream", "nohost", "--dir", "/tmp/w"]), /host:port/);
  assert.throws(() => parseArgs(["proxy", "--listen", "0x20", "--dir", "/tmp/w"]), /port number/);
  assert.throws(() => parseArgs(["proxy", "--listen", "99999", "--dir", "/tmp/w"]), /out of range/);
});

/* ── reading requests back off the wire ─────────────────────────────────── */

test("splitRequests frames pipelined requests by content-length", () => {
  const raw = Buffer.from(
    wire("GET", "/v1/ref") + wire("PUT", "/v1/objects/ab12", sealed("SBO1")) + wire("GET", "/v1/key"),
    "latin1",
  );
  const { requests, trailing } = splitRequests(raw);
  assert.equal(trailing, 0);
  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.target} ${request.bodyLength} ${request.magic}`),
    ["GET /v1/ref 0 ", "PUT /v1/objects/ab12 13 SBO1", "GET /v1/key 0 "],
  );
});

test("splitRequests reports a connection cut mid-body instead of guessing", () => {
  const whole = wire("PUT", "/v1/objects/ab12", sealed("SBO1"));
  const raw = Buffer.from(wire("GET", "/v1/ref") + whole.slice(0, whole.length - 4), "latin1");
  const { requests, trailing } = splitRequests(raw);
  assert.equal(requests.length, 1);
  assert.ok(trailing > 0, "the half request is counted, not silently dropped");
});

test("splitRequests throws on a framing it cannot read", () => {
  const chunked = "PUT /v1/ref HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n";
  assert.throws(() => splitRequests(Buffer.from(chunked, "latin1"), "c001.req"), /chunked/);
  const encoded = "PUT /v1/ref HTTP/1.1\r\nContent-Encoding: gzip\r\nContent-Length: 0\r\n\r\n";
  assert.throws(() => splitRequests(Buffer.from(encoded, "latin1"), "c001.req"), /encoded request body/);
  assert.throws(
    () => splitRequests(Buffer.from("garbage\r\nHost: x\r\n\r\n", "latin1")),
    /unreadable request line/,
  );
  assert.throws(
    () => splitRequests(Buffer.from("PUT /v1/ref HTTP/1.1\r\nHost 127.0.0.1\r\n\r\n", "latin1")),
    /unreadable header/,
  );
  assert.throws(
    () => splitRequests(Buffer.from("PUT /v1/ref HTTP/1.1\r\nContent-Length: many\r\n\r\n", "latin1")),
    /unreadable content-length/,
  );
});

/* ── the envelope audit ─────────────────────────────────────────────────── */

const bodied = (target: string, magic: string): WireRequest => ({
  method: "PUT",
  target,
  bodyLength: 64,
  magic,
});

test("auditBodies accepts each route carrying its own envelope", () => {
  assert.deepEqual(
    auditBodies([
      bodied("/v1/objects/ab12cd", "SBO1"),
      bodied("/v1/ref", "SBR1"),
      bodied("/v1/key", "SBK1"),
      bodied("/v1/spaces/s1/objects/ab12cd", "SBO1"),
      { method: "GET", target: "/v1/objects?since=c1", bodyLength: 0, magic: "" },
    ]),
    [],
  );
});

test("auditBodies names a body that is not its route's envelope", () => {
  const problems = auditBodies([bodied("/v1/objects/ab12cd", "SBR1"), bodied("/v1/ref", "---\n")]);
  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /not the object envelope SBO1/);
  assert.match(problems[1]!, /not the ref envelope SBR1/);
});

test("auditBodies refuses to vouch for a body on an unknown route", () => {
  const problems = auditBodies([bodied("/v1/spaces", "SBO1")]);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /no envelope rule/);
});

test("auditBodies reads the route out of a target that carries a query string", () => {
  // The transport appends cursors and space ids; the rule is about the path.
  assert.deepEqual(auditBodies([bodied("/v1/objects/ab12cd?ttl=1", "SBO1")]), []);
  const problems = auditBodies([bodied("/v1/objects/ab12cd?ttl=1", "SBR1")]);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /not the object envelope SBO1/);
});

/* ── the response audit ─────────────────────────────────────────────────── */

test("auditResponses names an encoded response and ignores request captures", () => {
  const problems = auditResponses([
    { name: "c001.req", raw: Buffer.from("PUT /v1/ref HTTP/1.1\r\nContent-Encoding: gzip\r\n\r\n", "latin1") },
    { name: "c001.res", raw: Buffer.from("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\n", "latin1") },
    { name: "c002.res", raw: Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", "latin1") },
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /^c001\.res: a response arrived with Content-Encoding: gzip/);
});

/* ── the plaintext scan ─────────────────────────────────────────────────── */

test("scanForbidden finds every hit, in headers as well as bodies", () => {
  const captures = [
    { name: "c001.req", raw: Buffer.from("PUT /v1/objects/leak-marker HTTP/1.1\r\n\r\n", "latin1") },
    { name: "c001.res", raw: Buffer.from("HTTP/1.1 200 OK\r\n\r\nleak-marker leak-marker", "latin1") },
  ];
  const hits = scanForbidden(captures, ["leak-marker"]);
  assert.equal(hits.length, 3);
  assert.match(hits[0]!, /^c001\.req@\d+/);
});

test("scanForbidden is silent on a capture that holds none of them", () => {
  const captures = [{ name: "c001.req", raw: Buffer.from(sealed("SBO1"), "latin1") }];
  assert.deepEqual(scanForbidden(captures, ["leak-marker", "another phrase"]), []);
});

/* ── the tee and the assertion, end to end ──────────────────────────────── */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for a file the proxy writes once it is actually listening. */
async function waitFor(path: string): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (existsSync(path)) return;
    await sleep(25);
  }
  throw new Error(`the proxy never became ready (${path})`);
}

/** A port the OS just handed back, so parallel test files never collide. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

test("the tee captures a real round trip and the assertion reads it back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autosync-wire-"));
  const capture = join(dir, "wire");
  const ready = join(dir, "ready");
  const upstream = createServer((request, response) => {
    request.resume();
    request.on("end", () => response.writeHead(201).end());
  });
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const listenPort = await freePort();

  const tee = spawn(
    process.execPath,
    [
      SCRIPT, "proxy",
      "--listen", String(listenPort),
      "--upstream", `127.0.0.1:${upstreamPort}`,
      "--dir", capture,
      "--ready", ready,
    ],
    { stdio: "ignore" },
  );
  try {
    await waitFor(ready);
    const body = sealed("SBO1", "\x02\x8f ciphertext-ish bytes");
    const sent = await fetch(`http://127.0.0.1:${listenPort}/v1/objects/ab12cd`, {
      method: "PUT",
      headers: { Authorization: "Bearer t", "Content-Type": "application/octet-stream" },
      body: Buffer.from(body, "latin1"),
    });
    assert.equal(sent.status, 201);
    await sleep(150);

    const green = spawnSync(
      process.execPath,
      [SCRIPT, "assert", "--dir", capture, "--forbid", "never-on-the-wire"],
      { encoding: "utf8" },
    );
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.match(green.stdout, /every uploaded body opened with its route's encryption envelope/);
    const report = JSON.parse(readFileSync(join(capture, "wire-report.json"), "utf8"));
    assert.equal(report.bodies, 1);
    assert.equal(report.magics.SBO1, 1);

    // The same capture, asked about a phrase it really does hold: the
    // assertion has to go red, or a green one means nothing.
    const red = spawnSync(
      process.execPath,
      [SCRIPT, "assert", "--dir", capture, "--forbid", "ciphertext-ish"],
      { encoding: "utf8" },
    );
    assert.equal(red.status, 1);
    assert.match(red.stderr, /plaintext hit\(s\) on the wire/);
  } finally {
    tee.kill();
    await new Promise<void>((done) => upstream.close(() => done()));
  }
});

test("the assertion refuses an empty capture directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "autosync-wire-empty-"));
  const run = spawnSync(process.execPath, [SCRIPT, "assert", "--dir", dir, "--forbid", "x"], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /the capture is empty/);
});

test("the assertion refuses a capture that uploaded nothing", () => {
  // The likeliest false green: the app never pushed, so no phrase could leak
  // and every body rule holds vacuously. A capture with traffic but no body
  // has to go red the same way an empty directory does.
  const dir = capture({
    "c001.req": wire("GET", "/v1/ref") + wire("GET", "/v1/objects?since=c1"),
    "c001.res": "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
  });
  const run = assertOn(dir, "--forbid", "never-on-the-wire");
  assert.equal(run.status, 1);
  assert.match(run.stderr, /nothing was ever uploaded/);
});

test("the assertion aggregates every connection in the capture", () => {
  const dir = capture({
    "c001.req": wire("GET", "/v1/ref") + wire("PUT", "/v1/objects/ab12", sealed("SBO1")),
    "c001.res": "HTTP/1.1 201 Created\r\nContent-Length: 0\r\n\r\n",
    "c002.req": wire("PUT", "/v1/ref", sealed("SBR1")) + wire("PUT", "/v1/key", sealed("SBK1")),
    "c002.res": "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
  });
  const run = assertOn(dir, "--forbid", "never-on-the-wire");
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const report = JSON.parse(readFileSync(join(dir, "wire-report.json"), "utf8"));
  assert.equal(report.connections, 2);
  assert.equal(report.requests, 4);
  assert.deepEqual(report.magics, { SBO1: 1, SBR1: 1, SBK1: 1 });
});

test("the assertion frames requests out of .req only, and still scans .res for leaks", () => {
  // A response is bytes on the wire, not a request: framing it would throw on
  // its status line and take a good run down with it.
  const dir = capture({
    "c001.req": wire("PUT", "/v1/objects/ab12", sealed("SBO1")),
    "c001.res": "HTTP/1.1 201 Created\r\nContent-Length: 0\r\n\r\n",
  });
  const green = assertOn(dir, "--forbid", "never-on-the-wire");
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, "wire-report.json"), "utf8")).requests, 1);

  const red = assertOn(dir, "--forbid", "201 Created");
  assert.equal(red.status, 1);
  assert.match(red.stderr, /c001\.res@\d+/);
});

test("the assertion reports the bytes a teardown cut off instead of hiding them", () => {
  const whole = wire("PUT", "/v1/objects/ab12", sealed("SBO1"));
  const dir = capture({
    "c001.req": whole + wire("PUT", "/v1/ref", sealed("SBR1")).slice(0, 20),
    "c001.res": "HTTP/1.1 201 Created\r\nContent-Length: 0\r\n\r\n",
  });
  const run = assertOn(dir, "--forbid", "never-on-the-wire");
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /20 trailing byte\(s\) — a connection cut at teardown/);
  assert.equal(JSON.parse(readFileSync(join(dir, "wire-report.json"), "utf8")).trailing, 20);
});

test("the assertion takes its phrases from a file and counts each one once", () => {
  const dir = capture({
    "c001.req": wire("PUT", "/v1/objects/ab12", sealed("SBO1")),
    "c001.res": "HTTP/1.1 201 Created\r\nContent-Length: 0\r\n\r\n",
  });
  const list = join(dir, "forbidden.txt");
  writeFileSync(list, "hyaline drift under the tape hiss\n\nTape Room Sessions\n");
  const green = assertOn(dir, "--forbid", "Tape Room Sessions", "--forbid-file", list);
  assert.equal(green.status, 0, green.stdout + green.stderr);
  // Three phrases handed in, one of them twice: the report says two.
  assert.equal(JSON.parse(readFileSync(join(dir, "wire-report.json"), "utf8")).forbidden, 2);

  const list2 = join(dir, "leaky.txt");
  writeFileSync(list2, "201 Created\n");
  const red = assertOn(dir, "--forbid-file", list2);
  assert.equal(red.status, 1);
  assert.match(red.stderr, /plaintext hit\(s\) on the wire/);
});

/** A latin1 string standing for the UTF-8 bytes `text` really has on the wire. */
const utf8 = (text: string): string => Buffer.from(text, "utf8").toString("latin1");

test("the assertion catches a leaked phrase that carries non-ASCII characters", () => {
  // The seed vault's prose is full of em dashes and curly apostrophes. Planted
  // in cleartext, in the UTF-8 the transport would really write, they have to
  // be findable — searching the phrase's latin1 bytes instead would make a
  // fifth of the forbidden list unmatchable and every run falsely green.
  const leak = "the tape hiss — a room’s own weather, not a fault…";
  const dir = capture({
    "c001.req": wire("PUT", "/v1/objects/ab12", sealed("SBO1")),
    "c001.res": `HTTP/1.1 201 Created\r\nContent-Length: 0\r\n\r\n${utf8(leak)}`,
  });
  const list = join(dir, "forbidden.txt");
  writeFileSync(list, `${leak}\n`, "utf8");

  const red = assertOn(dir, "--forbid-file", list);
  assert.equal(red.status, 1, red.stdout + red.stderr);
  assert.match(red.stderr, /plaintext hit\(s\) on the wire/);
  assert.match(red.stderr, /c001\.res@\d+/);
});

test("the assertion catches a leaked markdown heading, `#` and all", () => {
  // The forbidden list is machine-written from the vault on disk, so a line
  // opening with `#` is a heading the vault holds, not a comment about it.
  const leak = "## Release Weeks and what they cost";
  const dir = capture({
    "c001.req": wire("PUT", "/v1/objects/ab12", sealed("SBO1")).replace(
      "Host: 127.0.0.1\r\n",
      `Host: 127.0.0.1\r\nX-Note: ${leak}\r\n`,
    ),
    "c001.res": "HTTP/1.1 201 Created\r\nContent-Length: 0\r\n\r\n",
  });
  const list = join(dir, "forbidden.txt");
  writeFileSync(list, `${leak}\n`, "utf8");

  const red = assertOn(dir, "--forbid-file", list);
  assert.equal(red.status, 1, red.stdout + red.stderr);
  assert.match(red.stderr, /c001\.req@\d+/);
});

test("the assertion goes red on a response that arrived encoded", () => {
  const dir = capture({
    "c001.req": wire("PUT", "/v1/objects/ab12", sealed("SBO1")),
    "c001.res": "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 0\r\n\r\n",
  });
  const run = assertOn(dir, "--forbid", "never-on-the-wire");
  assert.equal(run.status, 1);
  assert.match(run.stderr, /encoded response\(s\)/);
});
