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
