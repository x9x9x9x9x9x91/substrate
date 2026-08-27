/** `ctx.schema` — the databases a kind can already read, and their registered
 *  properties.
 *
 *  What is worth pinning here is the projection, since that is the whole
 *  reason the module exists: the reserved `icon`/`home`/`parent` keys sit in
 *  a map typed as if they were property schemas, and a kind looping over the
 *  stored entry would draw a column called "icon". */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SchemaConfig } from "./types.ts";
import { kindSchema } from "./kindschema.ts";

const SCHEMA = {
  release: {
    icon: "disc",
    home: "Releases",
    status: { options: [{ value: "live" }, { value: "parked", color: "grey" }] },
    format: { kind: "multi", options: [{ value: "Digital" }] },
    released: { kind: "date", options: [], description: "the day it goes out" },
    catalogue: { kind: "text", options: [] },
    fee: { kind: "number", options: [], format: "eur" },
    label: { kind: "relation", options: [], type: "Label" },
  },
  moodboard: {},
} as unknown as SchemaConfig;

test("every database lands, with its props in stored order", () => {
  const got = kindSchema(SCHEMA);
  assert.deepEqual(
    got.map((d) => d.name),
    ["release", "moodboard"],
  );
  assert.deepEqual(
    got[0].props.map((p) => p.name),
    ["status", "format", "released", "catalogue", "fee", "label"],
  );
  // a database with no registered properties is a database that exists —
  // reading it as absent would be a different claim
  assert.deepEqual(got[1], { name: "moodboard", props: [] });
});

test("the reserved keys are not published as properties", () => {
  const props = kindSchema(SCHEMA)[0].props.map((p) => p.name);
  assert.equal(props.includes("icon"), false);
  assert.equal(props.includes("home"), false);
});

test("a kindless entry with options is a select, without them free text", () => {
  const props = kindSchema(SCHEMA)[0].props;
  assert.equal(props.find((p) => p.name === "status")?.kind, "select");
  assert.equal(props.find((p) => p.name === "catalogue")?.kind, "text");
  assert.deepEqual(
    kindSchema({ db: { loose: { options: [] } } } as unknown as SchemaConfig)[0].props[0].kind,
    "text",
  );
});

test("the per-kind extras ride along, and only where the kind has them", () => {
  const props = kindSchema(SCHEMA)[0].props;
  const by = (name: string) => props.find((p) => p.name === name)!;
  assert.deepEqual(by("status").options, [{ value: "live" }, { value: "parked", color: "grey" }]);
  assert.deepEqual(by("released").options, []);
  assert.equal(by("released").description, "the day it goes out");
  assert.equal(by("fee").format, "eur");
  assert.equal(by("label").target, "Label");
  assert.equal(by("status").target, undefined);
  assert.equal(by("status").format, undefined);
  assert.equal(by("status").description, undefined);
});

test("options come back copied — vault code cannot rewrite the app's pickers", () => {
  const live = { release: { status: { options: [{ value: "live" }] } } } as unknown as SchemaConfig;
  kindSchema(live)[0].props[0].options.push({ value: "invented" });
  assert.deepEqual(live.release.status.options, [{ value: "live" }]);
});

test("an empty vault reads as no databases rather than throwing", () => {
  assert.deepEqual(kindSchema({} as SchemaConfig), []);
  assert.deepEqual(kindSchema(undefined as unknown as SchemaConfig), []);
});
