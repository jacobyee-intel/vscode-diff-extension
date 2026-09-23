import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  getChangedFiles,
  getFileDiff,
  GitError,
  isBinaryContent,
  isBinaryFile,
  isNotRepositoryError,
  parseNameStatus,
  parseNullDelimitedPaths,
  resolveRepositoryPath
} from "../src/git";
import { parseUnifiedDiff } from "../src/diffParser";

let directoryIndex = 0;
const execFileAsync = promisify(execFile);

async function makeScratch(name: string): Promise<string> {
  const directory = path.resolve(
    ".test-work",
    `${name}-${process.pid}-${directoryIndex++}`
  );
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  return directory;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8"
  });
  return result.stdout;
}

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

void test("rejects malformed or truncated Git status output", () => {
  assert.throws(() => parseNameStatus("X\0file.txt\0"), /Unsupported/u);
  assert.throws(() => parseNameStatus("Rbad\0old\0new\0"), /Malformed/u);
  assert.throws(() => parseNameStatus("M\0"), /Truncated/u);
  assert.throws(() => parseNameStatus("R100\0old\0"), /Truncated/u);
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

void test("detects NUL bytes using Git's bounded binary heuristic", () => {
  assert.equal(isBinaryContent(Buffer.from("plain text\n")), false);
  assert.equal(isBinaryContent(Buffer.from([0x61, 0x00, 0x62])), true);
});

void test("limits binary inspection to Git's 8,000-byte probe", async () => {
  const directory = await makeScratch("probe");
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
  const repoRoot = await makeScratch("binary");
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
  const repoRoot = await makeScratch("text");
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

void test("parses real multi-section Git diffs for C-quoted special paths", async () => {
  const repoRoot = await makeScratch("quoted-paths");
  const paths = [
    "tab\tname.txt",
    "line\nname.txt",
    "quote\"name.txt",
    "back\\slash.txt"
  ];
  try {
    await git(repoRoot, "init", "--quiet");
    await git(repoRoot, "config", "user.name", "Branch Diff Tests");
    await git(repoRoot, "config", "user.email", "branch-diff@example.invalid");
    for (const [index, filePath] of paths.entries()) {
      await writeFile(path.join(repoRoot, filePath), `old-${index}\n`);
    }
    await git(repoRoot, "add", "--all");
    await git(repoRoot, "commit", "--quiet", "-m", "base");
    const mergeBase = (await git(repoRoot, "rev-parse", "HEAD")).trim();

    for (const [index, filePath] of paths.entries()) {
      await writeFile(path.join(repoRoot, filePath), `new-${index}\n`);
    }

    const changed = await getChangedFiles(repoRoot, mergeBase);
    assert.deepEqual(changed.map((file) => file.path), [...paths].sort());

    const output = await git(
      repoRoot,
      "-c",
      "core.quotePath=false",
      "diff",
      "--unified=0",
      "--no-color",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      mergeBase
    );
    for (const [index, filePath] of paths.entries()) {
      const target = { oldPath: filePath, newPath: filePath };
      const parsedSection = parseUnifiedDiff(output, target);
      assert.deepEqual(parsedSection.deletedBlocks[0]?.lines, [`old-${index}`]);

      const parsedFile = await getFileDiff(
        repoRoot,
        mergeBase,
        changed.find((file) => file.path === filePath)!
      );
      assert.deepEqual(parsedFile.deletedBlocks[0]?.lines, [`old-${index}`]);
    }
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
