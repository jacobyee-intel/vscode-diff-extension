import assert from "node:assert/strict";
import test from "node:test";
import { parseUnifiedDiff } from "../src/diffParser";

void test("classifies pure additions", () => {
  const parsed = parseUnifiedDiff(
    "@@ -2,0 +3,2 @@\n+first\n+second\n"
  );

  assert.deepEqual(parsed.added, [{ start: 2, end: 4 }]);
  assert.deepEqual(parsed.modified, []);
  assert.deepEqual(parsed.deletedMarkers, []);
});

void test("classifies replacements using old and new counts", () => {
  const parsed = parseUnifiedDiff(
    "@@ -4,2 +4,3 @@\n-old\n-old two\n+new\n+new two\n+extra\n"
  );

  assert.deepEqual(parsed.modified, [{ start: 3, end: 5 }]);
  assert.deepEqual(parsed.added, [{ start: 5, end: 6 }]);
  assert.deepEqual(parsed.deletedMarkers, []);
});

void test("adds a marker for deleted-only hunks", () => {
  const parsed = parseUnifiedDiff("@@ -3,2 +2,0 @@\n-old\n-old two\n");

  assert.deepEqual(parsed.added, []);
  assert.deepEqual(parsed.modified, []);
  assert.deepEqual(parsed.deletedMarkers, [1]);
});

void test("marks excess removed replacement lines as deleted", () => {
  const parsed = parseUnifiedDiff(
    "@@ -10,4 +10,2 @@\n-a\n-b\n-c\n-d\n+x\n+y\n"
  );

  assert.deepEqual(parsed.modified, [{ start: 9, end: 11 }]);
  assert.deepEqual(parsed.deletedMarkers, [10]);
});

void test("detects binary patches", () => {
  const parsed = parseUnifiedDiff(
    "diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n"
  );

  assert.equal(parsed.binary, true);
  assert.deepEqual(parsed.added, []);
});

void test("merges adjacent ranges from consecutive hunks", () => {
  const parsed = parseUnifiedDiff(
    "@@ -1,0 +1 @@\n+a\n@@ -1,0 +2 @@\n+b\n"
  );

  assert.deepEqual(parsed.added, [{ start: 0, end: 2 }]);
});
