import assert from "node:assert/strict";
import test from "node:test";
import { buildDiffModel } from "../src/diffModel";
import { parseUnifiedDiff } from "../src/diffParser";

const target = { oldPath: "src/file.txt", newPath: "src/file.txt" };

function section(body: string, path = target): string {
  return `diff --git a/${path.oldPath} b/${path.newPath}\n--- a/${path.oldPath}\n+++ b/${path.newPath}\n${body}`;
}

void test("retains complete equal replacement text above modified rows", () => {
  const parsed = parseUnifiedDiff(
    section("@@ -4,2 +4,2 @@\n-old\n-old two\n+new\n+new two\n"),
    target
  );
  assert.deepEqual(parsed.modified, [{ start: 3, end: 5 }]);
  assert.deepEqual(parsed.deletedBlocks, [
    { afterLine: 2, originalStartLine: 4, lines: ["old", "old two"] }
  ]);
});

void test("classifies unequal replacement additions without truncating old rows", () => {
  const parsed = parseUnifiedDiff(
    section("@@ -4,2 +4,3 @@\n-old\n-old two\n+new\n+new two\n+extra\n"),
    target
  );
  assert.deepEqual(parsed.modified, [{ start: 3, end: 5 }]);
  assert.deepEqual(parsed.added, [{ start: 5, end: 6 }]);
  assert.deepEqual(parsed.deletedBlocks[0]?.lines, ["old", "old two"]);
});

void test("anchors pure deletions at beginning, middle, and EOF", () => {
  assert.equal(
    parseUnifiedDiff(section("@@ -1,2 +0,0 @@\n-a\n-b\n"), target)
      .deletedBlocks[0]?.afterLine,
    -1
  );
  assert.equal(
    parseUnifiedDiff(section("@@ -3,1 +2,0 @@\n-c\n"), target)
      .deletedBlocks[0]?.afterLine,
    1
  );
  assert.equal(
    parseUnifiedDiff(section("@@ -4,1 +3,0 @@\n-d\n"), target)
      .deletedBlocks[0]?.afterLine,
    2
  );
});

void test("handles multiple change groups and context count-driven", () => {
  const parsed = parseUnifiedDiff(
    section(
      "@@ -2,5 +2,5 @@\n-old-a\n+new-a\n same\n-old-b\n-old-c\n+new-b\n+new-c\n tail\n"
    ),
    target
  );
  assert.deepEqual(parsed.modified, [
    { start: 1, end: 2 },
    { start: 3, end: 5 }
  ]);
  assert.deepEqual(parsed.deletedBlocks, [
    { afterLine: 0, originalStartLine: 2, lines: ["old-a"] },
    {
      afterLine: 2,
      originalStartLine: 4,
      lines: ["old-b", "old-c"]
    }
  ]);
});

void test("preserves empty lines, Git-like prefixes, CRLF, and newline markers", () => {
  const parsed = parseUnifiedDiff(
    section(
      "@@ -1,3 +1,1 @@\r\n-\r\n-diff --git a/x b/x\r\n---- source-like\r\n+replacement\r\n\\ No newline at end of file\r\n"
    ),
    target
  );
  assert.deepEqual(parsed.deletedBlocks[0]?.lines, [
    "",
    "diff --git a/x b/x",
    "--- source-like"
  ]);
});

void test("selects only the requested rename section", () => {
  const renamed = { oldPath: "old name.txt", newPath: "new name.txt" };
  const output =
    section("@@ -1 +1 @@\n-wrong\n+wrong-new\n") +
    section("@@ -1 +1 @@\n-right\n+right-new\n", renamed);
  const parsed = parseUnifiedDiff(output, renamed);
  assert.deepEqual(parsed.deletedBlocks[0]?.lines, ["right"]);
});

void test("selects Git C-quoted paths with control, quote, slash escapes, and octal bytes", () => {
  const special = {
    oldPath: "dir/tab\tline\nquote\"slash\\é.txt",
    newPath: "dir/tab\tline\nquote\"slash\\é.txt"
  };
  const quotedHeader =
    "diff --git \"a/dir/tab\\tline\\nquote\\\"slash\\\\\\303\\251.txt\" " +
    "\"b/dir/tab\\tline\\nquote\\\"slash\\\\\\303\\251.txt\"\n";
  const output =
    section("@@ -1 +1 @@\n-other\n+other-new\n") +
    quotedHeader +
    "--- \"a/ignored\"\n+++ \"b/ignored\"\n" +
    "@@ -1 +1 @@\n-old-special\n+new-special\n";

  const parsed = parseUnifiedDiff(output, special);
  assert.deepEqual(parsed.deletedBlocks[0]?.lines, ["old-special"]);
});

void test("selects section headers with only one C-quoted rename path", () => {
  const renamed = { oldPath: "old\tname.txt", newPath: "new-name.txt" };
  const output =
    "diff --git \"a/old\\tname.txt\" b/new-name.txt\n" +
    "similarity index 50%\n" +
    "rename from \"old\\tname.txt\"\nrename to new-name.txt\n" +
    "--- \"a/old\\tname.txt\"\n+++ b/new-name.txt\n" +
    "@@ -1 +1 @@\n-old\n+new\n";
  assert.deepEqual(
    parseUnifiedDiff(output, renamed).deletedBlocks[0]?.lines,
    ["old"]
  );
});

void test("detects binary only in the selected section", () => {
  const other = { oldPath: "image.png", newPath: "image.png" };
  const output =
    section("@@ -1 +1 @@\n-text\n+changed\n") +
    `diff --git a/${other.oldPath} b/${other.newPath}\nBinary files a/image.png and b/image.png differ\n`;
  assert.equal(parseUnifiedDiff(output, target).binary, false);
  assert.equal(parseUnifiedDiff(output, other).binary, true);
});

void test("rejects missing, duplicate, malformed, and truncated sections", () => {
  assert.throws(() => parseUnifiedDiff(section("@@ -1 +1 @@\n-a\n+b\n"), {
    oldPath: "missing",
    newPath: "missing"
  }), /does not contain/u);
  const duplicate =
    section("@@ -1 +1 @@\n-a\n+b\n") +
    section("@@ -2 +2 @@\n-c\n+d\n");
  assert.throws(() => parseUnifiedDiff(duplicate, target), /multiple/u);
  assert.throws(
    () => parseUnifiedDiff(section("@@ malformed\n-a\n+b\n"), target),
    /Malformed hunk/u
  );
  assert.throws(
    () => parseUnifiedDiff(section("@@ -1,2 +1 @@\n-a\n+b\n"), target),
    /Truncated hunk/u
  );
  assert.throws(
    () =>
      parseUnifiedDiff(
        section("@@ -1 +1 @@\n\\ No newline at end of file\n-a\n+b\n"),
        target
      ),
    /Misplaced/u
  );
});

void test("rejects surplus hunk content and unexpected trailing garbage", () => {
  assert.throws(
    () =>
      parseUnifiedDiff(
        section("@@ -1 +1 @@\n-a\n+b\n+surplus\n"),
        target
      ),
    /Unexpected content/u
  );
  assert.throws(
    () =>
      parseUnifiedDiff(
        section("@@ -1 +1 @@\n-a\n+b\ntrailing garbage\n"),
        target
      ),
    /Unexpected content/u
  );
});

void test("rejects duplicate and misplaced no-newline markers", () => {
  assert.throws(
    () =>
      parseUnifiedDiff(
        section(
          "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n" +
            "\\ No newline at end of file\n+b\n"
        ),
        target
      ),
    /duplicate/u
  );
  assert.throws(
    () =>
      parseUnifiedDiff(
        section(
          "@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n" +
            "\\ No newline at end of file\n"
        ),
        target
      ),
    /duplicate/u
  );
});

void test("rejects malformed section transitions and accepts recognized metadata", () => {
  const malformed =
    section("@@ -1 +1 @@\n-a\n+b\n") +
    "diff --git \"a/broken\" not-quoted\n";
  assert.throws(
    () => parseUnifiedDiff(malformed, target),
    /Malformed diff section header/u
  );

  const metadata =
    `diff --git a/${target.oldPath} b/${target.newPath}\n` +
    "old mode 100644\nnew mode 100755\n" +
    "similarity index 80%\nrename from old.txt\nrename to new.txt\n" +
    "index 1234567..89abcde 100644\n" +
    `--- a/${target.oldPath}\n+++ b/${target.newPath}\n` +
    "@@ -1 +1 @@\n-old\n+new\n";
  assert.deepEqual(
    parseUnifiedDiff(metadata, target).deletedBlocks[0]?.lines,
    ["old"]
  );
});

void test("builds live models for additions, deletions, and CRLF", () => {
  const parsed = buildDiffModel(
    target.oldPath,
    target.newPath,
    "one\r\ntwo\r\n",
    "one\r\nreplacement\r\nthree\r\n"
  );
  assert.deepEqual(parsed.deletedBlocks[0]?.lines, ["two"]);
  assert.deepEqual(parsed.modified, [{ start: 1, end: 2 }]);
  assert.deepEqual(parsed.added, [{ start: 2, end: 3 }]);
});

void test("builds live models without embedding repository paths in patch headers", () => {
  const specialPath = "tab\tline\nquote\"slash\\.txt";
  const parsed = buildDiffModel(
    specialPath,
    specialPath,
    "old\n",
    "new\n"
  );
  assert.deepEqual(parsed.deletedBlocks[0]?.lines, ["old"]);
  assert.deepEqual(parsed.modified, [{ start: 0, end: 1 }]);
});

void test("does not cap many hunks or a large deleted block", () => {
  const oldLines = Array.from({ length: 2_000 }, (_, index) => `old-${index}`);
  const parsed = buildDiffModel(
    target.oldPath,
    target.newPath,
    `${oldLines.join("\n")}\n`,
    ""
  );
  assert.equal(parsed.deletedBlocks.length, 1);
  assert.equal(parsed.deletedBlocks[0]?.lines.length, 2_000);

  const oldMany = Array.from({ length: 400 }, (_, index) => `same-${index}`);
  const newMany = [...oldMany];
  for (let index = 0; index < newMany.length; index += 2) {
    newMany[index] = `changed-${index}`;
  }
  const many = buildDiffModel(
    target.oldPath,
    target.newPath,
    `${oldMany.join("\n")}\n`,
    `${newMany.join("\n")}\n`
  );
  assert.equal(many.deletedBlocks.length, 200);
});
