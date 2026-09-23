import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findRepositoryRoot,
  getFileDiff,
  GitError,
  isBinaryContent,
  isBinaryFile,
  isNotRepositoryError,
  parseNameStatus,
  parseNullDelimitedPaths,
  resolveRepositoryPath
} from "../src/git";

void test("parses NUL-delimited statuses without splitting paths on spaces", () => {
  const parsed = parseNameStatus(
    "M\0src/file with spaces.ts\0A\0new file.txt\0D\0old.txt\0"
  );

  assert.deepEqual(parsed, [
    {
      status: "M",
      path: "src/file with spaces.ts",
      untracked: false
    },
    {
      status: "A",
      path: "new file.txt",
      untracked: false
    },
    {
      status: "D",
      path: "old.txt",
      untracked: false
    }
  ]);
});

void test("parses rename scores and both rename paths", () => {
  const parsed = parseNameStatus(
    "R087\0src/old name.ts\0src/new name.ts\0"
  );

  assert.deepEqual(parsed, [
    {
      status: "R",
      oldPath: "src/old name.ts",
      path: "src/new name.ts",
      score: 87,
      untracked: false
    }
  ]);
});

void test("parses NUL-delimited untracked paths", () => {
  assert.deepEqual(
    parseNullDelimitedPaths("one.txt\0folder/two with spaces.txt\0"),
    ["one.txt", "folder/two with spaces.txt"]
  );
});

void test("classifies only expected not-a-repository Git failures", () => {
  assert.equal(
    isNotRepositoryError(
      new GitError(
        "not a repository",
        ["rev-parse", "--show-toplevel"],
        128,
        "fatal: not a git repository (or any of the parent directories): .git"
      )
    ),
    true
  );
  assert.equal(
    isNotRepositoryError(
      new GitError(
        "cannot execute",
        ["rev-parse", "--show-toplevel"],
        null,
        "spawn git ENOENT"
      )
    ),
    false
  );
  assert.equal(
    isNotRepositoryError(
      new GitError(
        "unsafe repository",
        ["rev-parse", "--show-toplevel"],
        128,
        "fatal: detected dubious ownership in repository"
      )
    ),
    false
  );
});

void test("findRepositoryRoot returns undefined outside a repository", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "branch-diff-no-repo-"));
  try {
    assert.equal(await findRepositoryRoot(directory), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("detects NUL bytes using Git's bounded binary heuristic", () => {
  assert.equal(isBinaryContent(Buffer.from("plain text\n")), false);
  assert.equal(isBinaryContent(Buffer.from([0x61, 0x00, 0x62])), true);
});

void test("limits binary inspection to Git's 8,000-byte probe", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "branch-diff-probe-"));
  try {
    const filePath = path.join(directory, "large.dat");
    await writeFile(
      filePath,
      Buffer.concat([Buffer.alloc(8_000, 0x61), Buffer.from([0])])
    );
    assert.equal(await isBinaryFile(filePath), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("returns a binary diff for untracked binary files", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "branch-diff-binary-"));
  try {
    await writeFile(path.join(repoRoot, "image.dat"), Buffer.from([1, 0, 2]));
    const parsed = await getFileDiff(repoRoot, "unused", {
      status: "??",
      path: "image.dat",
      untracked: true
    });

    assert.equal(parsed.binary, true);
    assert.equal(parsed.wholeFileAdded, false);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

void test("returns a whole-file diff for untracked text files", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "branch-diff-text-"));
  try {
    await writeFile(path.join(repoRoot, "notes.txt"), "hello\n");
    const parsed = await getFileDiff(repoRoot, "unused", {
      status: "??",
      path: "notes.txt",
      untracked: true
    });

    assert.equal(parsed.binary, false);
    assert.equal(parsed.wholeFileAdded, true);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

void test("rejects repository paths that escape the repository", () => {
  assert.throws(
    () => resolveRepositoryPath("/repo", "../outside.dat"),
    /outside the repository/u
  );
  assert.throws(
    () => resolveRepositoryPath("/repo", "/absolute.dat"),
    /Invalid repository path/u
  );
});
