import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clockTime,
  fileExt,
  fileKind,
  isPlayableFile,
  playableFiles,
  stepIndex,
} from "./folderfiles.ts";
import type { FolderFile } from "./types.ts";

function file(name: string): FolderFile {
  return { rel: `Masters/${name}`, name, path: `/v/Masters/${name}`, size: 4, mtime_ms: 1 };
}

test("audio rows play; the rest are plain rows", () => {
  assert.equal(isPlayableFile(file("bounce.wav")), true);
  assert.equal(isPlayableFile(file("MASTER.AIFF")), true);
  assert.equal(isPlayableFile(file("take.flac")), true);
  assert.equal(isPlayableFile(file("voice.m4a")), true);
  assert.equal(isPlayableFile(file("session.als")), false);
  assert.equal(isPlayableFile(file("sleeve.png")), false);
  assert.equal(isPlayableFile(file("contract.pdf")), false);
});

test("fileKind separates audio, image and everything else", () => {
  assert.equal(fileKind(file("bounce.wav")), "audio");
  assert.equal(fileKind(file("sleeve.png")), "image");
  assert.equal(fileKind(file("IMG_0231.heic")), "image");
  assert.equal(fileKind(file("session.als")), "other");
  assert.equal(fileKind(file("LICENSE")), "other");
});

test("the playlist is the playable subset, in listing order", () => {
  const files = [file("01.wav"), file("cover.png"), file("02.wav"), file("session.als")];
  assert.deepEqual(
    playableFiles(files).map((f) => f.name),
    ["01.wav", "02.wav"]
  );
  assert.deepEqual(playableFiles([file("notes.txt")]), []);
});

test("fileExt marks the type, and declines when there is nothing to mark", () => {
  assert.equal(fileExt("bounce.wav"), "WAV");
  assert.equal(fileExt("Umbra Session.als"), "ALS");
  assert.equal(fileExt("archive.tar.gz"), "GZ");
  assert.equal(fileExt("LICENSE"), null);
  assert.equal(fileExt(".hidden"), null, "a leading dot is not an extension");
  assert.equal(fileExt("trailing."), null);
  assert.equal(fileExt("v1.2 final mix"), null, "a dotted name is not an extension");
});

test("stepIndex wraps both ways and survives degenerate lengths", () => {
  assert.equal(stepIndex(3, 0, 1), 1);
  assert.equal(stepIndex(3, 2, 1), 0, "next past the end wraps to the top");
  assert.equal(stepIndex(3, 0, -1), 2, "prev from the top wraps to the end");
  assert.equal(stepIndex(1, 0, 1), 0);
  assert.equal(stepIndex(1, 0, -1), 0);
  assert.equal(stepIndex(0, 0, 1), 0);
});

test("clockTime renders mm:ss and refuses to print NaN", () => {
  assert.equal(clockTime(0), "0:00");
  assert.equal(clockTime(9), "0:09");
  assert.equal(clockTime(61), "1:01");
  assert.equal(clockTime(3599), "59:59");
  assert.equal(clockTime(3600), "60:00");
  assert.equal(clockTime(Number.NaN), "–:––");
  assert.equal(clockTime(Number.POSITIVE_INFINITY), "–:––");
  assert.equal(clockTime(-1), "–:––");
});
