import assert from "node:assert/strict";
import test from "node:test";
import { Text } from "@codemirror/state";
import {
  findAudioAnnotationBlocks,
  formatAnnotationTime,
  formatAudioAnnotation,
  newAudioAnnotationFence,
  parseAnnotationTime,
  resolveAudioAnnotationTarget,
  scanAudioAnnotationFences,
} from "./audio-annotations.ts";

test("annotation timestamps parse and format without losing long-file positions", () => {
  assert.equal(parseAnnotationTime("01:23"), 83);
  assert.equal(parseAnnotationTime("1:02:03"), 3723);
  assert.equal(parseAnnotationTime("61:03"), 3663);
  assert.equal(parseAnnotationTime("01:60"), null);
  assert.equal(parseAnnotationTime("1:60:00"), null);
  assert.equal(formatAnnotationTime(83.9), "01:23");
  assert.equal(formatAnnotationTime(3723), "62:03");
  assert.equal(formatAnnotationTime(60_000), "1000:00");
  assert.equal(parseAnnotationTime(formatAnnotationTime(60_000)), 60_000);
});

test("annotation lines are canonical and single-line", () => {
  assert.equal(formatAudioAnnotation(10.8, "  bass\n too   woody "), "00:10 — bass too woody");
  assert.equal(
    newAudioAnnotationFence("mix v3.wav", 130, "fixed the build"),
    "\n\n```annotations\naudio: mix v3.wav\n02:10 — fixed the build\n```"
  );
});

test("an adjacent matching fence binds to its exact audio file", () => {
  const source =
    "Before\n\n![[mix v3.wav]]\n\n```annotations\n" +
    "audio: mix v3.wav\n01:23 — bass too woody\n- 02:10 - fixed the build\n```\n\nAfter\n";
  assert.deepEqual(findAudioAnnotationBlocks(source), [
    {
      name: "mix v3.wav",
      from: 8,
      to: 110,
      embedFrom: 8,
      embedTo: 23,
      embedLineTo: 23,
      closeFrom: 107,
      annotations: [
        { seconds: 83, text: "bass too woody" },
        { seconds: 130, text: "fixed the build" },
      ],
    },
  ]);
});

test("an opener's indent caps three past its container, the way lezer caps it", () => {
  // Binding outside a column is gated on lezer's FencedCode, which stops four
  // columns past the CONTAINER's content column; this walk took any indent, so
  // a 4-space-indented fence bound inside a column and rendered as indented
  // code outside one — and a note written from that player landed in what
  // markdown calls a code block, not a fence. At top level the container
  // starts at column 0, so the cap reads as an absolute three here.
  const body = (indent: string) =>
    `Before\n\n![[mix.wav]]\n\n${indent}\`\`\`annotations\n` +
    `${indent}audio: mix.wav\n${indent}01:23 — bass too woody\n${indent}\`\`\`\n`;
  for (const indent of ["", " ", "   "]) {
    assert.equal(findAudioAnnotationBlocks(body(indent)).length, 1, `indent ${indent.length} binds`);
  }
  assert.equal(findAudioAnnotationBlocks(body("    ")).length, 0, "four spaces is indented code");
  assert.equal(findAudioAnnotationBlocks(body("\t")).length, 0, "a tab is indented code too");
});

test("a fence nested in a list binds where lezer says it does", () => {
  // The cap is RELATIVE: lezer opens a fence whose indent is less than four
  // columns past its container's content column. An absolute cap at three
  // stopped binding an annotations fence two list levels deep — flush with its
  // own container, a fence to lezer and to every reader — and the write-back
  // then saw no fence following the embed and inserted a SECOND one, flush
  // left, between the embed and the fence already there, breaking the list.
  const nested =
    "- outer\n  - inner\n\n    ![[mix.wav]]\n\n" +
    "    ```annotations\n    audio: mix.wav\n    01:23 — bass too woody\n    ```\n";
  const blocks = findAudioAnnotationBlocks(nested);
  assert.equal(blocks.length, 1, "a list-nested fence binds");
  assert.deepEqual(blocks[0].annotations, [{ seconds: 83, text: "bass too woody" }]);

  // The write-back half: the resolver must SEE that fence, or the composer
  // takes the newAudioAnnotationFence branch and writes the duplicate.
  const doc = Text.of(nested.split("\n"));
  const target = resolveAudioAnnotationTarget(doc, nested.indexOf("![[mix.wav]]"), "mix.wav");
  assert.ok(target, "the embed resolves");
  assert.equal(target.annotationFenceFollows, true, "no duplicate fence is written");
  assert.equal(target.block?.annotations.length, 1);

  // Still relative, not simply wide: four columns past the container is
  // indented code inside the list exactly as it is at top level.
  const overIndented =
    "- outer\n  - inner\n\n    ![[mix.wav]]\n\n" +
    "        ```annotations\n        audio: mix.wav\n        01:23 — woody\n        ```\n";
  assert.equal(findAudioAnnotationBlocks(overIndented).length, 0, "four past the container is code");
});

test("mismatched, malformed, non-audio, and documented examples stay raw", () => {
  assert.equal(
    findAudioAnnotationBlocks(
      "![[mix.wav]]\n```annotations\naudio: other.wav\n00:01 — nope\n```"
    ).length,
    0
  );
  assert.equal(
    findAudioAnnotationBlocks(
      "![[mix.wav]]\n```annotations\naudio: mix.wav\nnot a timestamp\n```"
    ).length,
    0
  );
  assert.equal(
    findAudioAnnotationBlocks(
      "![[cover.png]]\n```annotations\naudio: cover.png\n00:01 — nope\n```"
    ).length,
    0
  );
  assert.equal(
    findAudioAnnotationBlocks(
      "````markdown\n![[mix.wav]]\n```annotations\naudio: mix.wav\n00:01 — example\n```\n````"
    ).length,
    0
  );
});

test("a malformed adjacent fence guards the embed instead of orphaning it", () => {
  const source =
    "Before\n![[mix.wav]]\n\n```annotations\n" +
    "audio: mix.wav\nnot a timestamp\n```\nAfter";
  const doc = Text.of(source.split("\n"));
  const fenceFrom = source.indexOf("```annotations");
  const scan = scanAudioAnnotationFences(doc, [[fenceFrom, source.indexOf("```\nAfter") + 3]]);
  const embedFrom = source.indexOf("![[mix.wav]]");
  assert.deepEqual(scan.blocks, []);
  assert.deepEqual(scan.guardedEmbeds, [[embedFrom, embedFrom + "![[mix.wav]]".length]]);

  const target = resolveAudioAnnotationTarget(doc, embedFrom, "mix.wav");
  assert.equal(target?.annotationFenceFollows, true);
  assert.equal(target?.block, null);
});

test("write positions resolve from the current shifted document", () => {
  const source =
    "New text inserted above\n\n![[mix.wav]]\n\n```annotations\n" +
    "audio: mix.wav\n00:01 — keep me\n```";
  const doc = Text.of(source.split("\n"));
  const embedFrom = source.indexOf("![[mix.wav]]");
  const target = resolveAudioAnnotationTarget(doc, embedFrom, "mix.wav");
  assert.equal(target?.embedFrom, embedFrom);
  assert.equal(target?.block?.closeFrom, source.lastIndexOf("```"));
});

test("an out-of-range write-back address bails instead of probing the last line", () => {
  // clamping to doc.length asked the closing lines of the note whether they
  // carried an embed of this name, so a second embed of the same file at the
  // bottom answered for a player that is no longer there
  const source = "![[mix.wav]]\n\nprose\n\n![[mix.wav]]\n";
  const doc = Text.of(source.split("\n"));
  assert.equal(resolveAudioAnnotationTarget(doc, doc.length + 40, "mix.wav"), null);
  assert.equal(resolveAudioAnnotationTarget(doc, -1, "mix.wav"), null);
  // the in-range address still resolves, to its own embed
  assert.equal(resolveAudioAnnotationTarget(doc, 0, "mix.wav")?.embedFrom, 0);
});

test("a sized audio embed still binds to its annotation fence (SUB-1102)", () => {
  const blocks = findAudioAnnotationBlocks(
    "![[mix v3.wav|left]]\n```annotations\naudio: mix v3.wav\n01:23 — bass too woody\n```"
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].name, "mix v3.wav");
});
