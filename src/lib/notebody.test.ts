import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  dropRememberedNoteBodies,
  forgetNoteBody,
  rememberNoteBody,
  rememberedNoteBody,
  rememberedNoteBodyCount,
} from "./notebody.ts";

beforeEach(() => {
  dropRememberedNoteBodies();
});

test("a path with no held body reads back null", () => {
  assert.equal(rememberedNoteBody("Dashboards/Umbra Home.md"), null);
});

test("a remembered body is the seed for the next mount", () => {
  rememberNoteBody("Dashboards/Umbra Home.md", "# Umbra\n\nbody");
  assert.equal(rememberedNoteBody("Dashboards/Umbra Home.md"), "# Umbra\n\nbody");
  assert.equal(rememberedNoteBody("Dashboards/Other.md"), null);
});

test("a second read replaces the held copy — the seed never lags two reads", () => {
  rememberNoteBody("a.md", "first");
  rememberNoteBody("a.md", "second");
  assert.equal(rememberedNoteBody("a.md"), "second");
  assert.equal(rememberedNoteBodyCount(), 1);
});

test("forgetting one path leaves the rest seeded", () => {
  rememberNoteBody("a.md", "A");
  rememberNoteBody("b.md", "B");
  forgetNoteBody("a.md");
  assert.equal(rememberedNoteBody("a.md"), null);
  assert.equal(rememberedNoteBody("b.md"), "B");
});

test("forgetting an unheld path is a no-op", () => {
  rememberNoteBody("a.md", "A");
  forgetNoteBody("never-read.md");
  assert.equal(rememberedNoteBodyCount(), 1);
});

test("the purge drops every held body", () => {
  rememberNoteBody("a.md", "A");
  rememberNoteBody("b.md", "B");
  dropRememberedNoteBodies();
  assert.equal(rememberedNoteBodyCount(), 0);
  assert.equal(rememberedNoteBody("a.md"), null);
});

test("retention is bounded — the least recently read body falls out first", () => {
  for (let i = 0; i < 40; i += 1) rememberNoteBody(`n${i}.md`, `body ${i}`);
  assert.equal(rememberedNoteBodyCount(), 32);
  assert.equal(rememberedNoteBody("n0.md"), null, "oldest evicted");
  assert.equal(rememberedNoteBody("n7.md"), null, "oldest evicted");
  assert.equal(rememberedNoteBody("n8.md"), "body 8", "newest 32 kept");
  assert.equal(rememberedNoteBody("n39.md"), "body 39");
});

test("re-reading a body refreshes its place in the queue", () => {
  for (let i = 0; i < 32; i += 1) rememberNoteBody(`n${i}.md`, `body ${i}`);
  rememberNoteBody("n0.md", "body 0 again");
  rememberNoteBody("fresh.md", "fresh");
  assert.equal(rememberedNoteBody("n0.md"), "body 0 again", "touched, so not the oldest");
  assert.equal(rememberedNoteBody("n1.md"), null, "next-oldest evicted instead");
  assert.equal(rememberedNoteBodyCount(), 32);
});
