import { spawn } from "node:child_process";
import { open, lstat } from "node:fs/promises";
import path from "node:path";
import type { ChangedFile, GitFileStatus, ParsedFileDiff } from "./types";
import {
  addedWholeFileDiff,
  binaryFileDiff,
  parseUnifiedDiff
} from "./diffParser";

const BINARY_SNIFF_BYTES = 8_000;

export class GitError extends Error {
  public constructor(
    message: string,
    public readonly args: readonly string[],
    public readonly exitCode: number | null,
    public readonly stderr: string
  ) {
    super(message);
    this.name = "GitError";
  }
}

async function runGit(
  cwd: string,
  args: readonly string[],
  acceptedExitCodes: readonly number[] = [0]
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      reject(
        new GitError(
          `Unable to run Git: ${error.message}`,
          args,
          null,
          error.message
        )
      );
    });
    child.on("close", (exitCode) => {
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (exitCode !== null && acceptedExitCodes.includes(exitCode)) {
        resolve(stdoutText);
        return;
      }

      reject(
        new GitError(
          stderrText || `Git exited with code ${String(exitCode)}.`,
          args,
          exitCode,
          stderrText
        )
      );
    });
  });
}

function parseStatus(statusField: string): {
  status: GitFileStatus;
  score?: number;
} {
  if (statusField.startsWith("R") || statusField.startsWith("C")) {
    return {
      status: statusField[0] as GitFileStatus,
      score: Number(statusField.slice(1))
    };
  }

  const status = statusField[0];
  if (
    status === "A" ||
    status === "M" ||
    status === "D" ||
    status === "T" ||
    status === "U"
  ) {
    return { status };
  }

  return { status: "M" };
}

export function parseNameStatus(output: string): ChangedFile[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") {
    fields.pop();
  }

  const files: ChangedFile[] = [];
  for (let index = 0; index < fields.length; ) {
    const statusField = fields[index];
    const firstPath = fields[index + 1];
    if (statusField === undefined || firstPath === undefined) {
      break;
    }

    const parsedStatus = parseStatus(statusField);
    if (parsedStatus.status === "R" || parsedStatus.status === "C") {
      const newPath = fields[index + 2];
      if (newPath === undefined) {
        break;
      }
      files.push({
        status: parsedStatus.status,
        oldPath: firstPath,
        path: newPath,
        score: parsedStatus.score,
        untracked: false
      });
      index += 3;
    } else {
      files.push({
        status: parsedStatus.status,
        path: firstPath,
        untracked: false
      });
      index += 2;
    }
  }

  return files;
}

export function parseNullDelimitedPaths(output: string): string[] {
  return output.split("\0").filter((value) => value.length > 0);
}

export function isNotRepositoryError(error: unknown): boolean {
  return (
    error instanceof GitError &&
    error.exitCode === 128 &&
    /(?:not a git repository|must be run in a work tree)/iu.test(error.stderr)
  );
}

export function resolveRepositoryPath(
  repoRoot: string,
  repositoryPath: string
): string {
  if (
    repositoryPath.length === 0 ||
    repositoryPath.includes("\0") ||
    path.posix.isAbsolute(repositoryPath) ||
    path.isAbsolute(repositoryPath)
  ) {
    throw new Error(`Invalid repository path: ${repositoryPath}`);
  }

  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, ...repositoryPath.split("/"));
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path is outside the repository: ${repositoryPath}`);
  }
  return resolved;
}

export function isBinaryContent(content: Uint8Array): boolean {
  return content.includes(0);
}

export async function isBinaryFile(filePath: string): Promise<boolean> {
  const stats = await lstat(filePath);
  if (stats.isSymbolicLink()) {
    return false;
  }
  if (!stats.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }

  const handle = await open(filePath, "r");
  try {
    const content = Buffer.allocUnsafe(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(
      content,
      0,
      content.length,
      0
    );
    return isBinaryContent(content.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export async function findRepositoryRoot(
  candidatePath: string
): Promise<string | undefined> {
  try {
    const output = await runGit(candidatePath, [
      "rev-parse",
      "--show-toplevel"
    ]);
    return path.resolve(output.trim());
  } catch (error) {
    if (isNotRepositoryError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function getCurrentBranch(repoRoot: string): Promise<string> {
  const args = ["symbolic-ref", "--quiet", "--short", "HEAD"] as const;
  try {
    const branch = (await runGit(repoRoot, args)).trim();
    if (branch.length > 0) {
      return branch;
    }
  } catch (error) {
    if (!(error instanceof GitError) || error.exitCode !== 1) {
      throw error;
    }
  }

  throw new GitError(
    "The repository is in detached HEAD state.",
    args,
    1,
    ""
  );
}

export async function getLocalBranches(repoRoot: string): Promise<string[]> {
  const output = await runGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/"
  ]);
  return output
    .split(/\r?\n/u)
    .map((branch) => branch.trim())
    .filter((branch) => branch.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

export async function localBranchExists(
  repoRoot: string,
  branch: string
): Promise<boolean> {
  try {
    await runGit(
      repoRoot,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      [0]
    );
    return true;
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) {
      return false;
    }
    throw error;
  }
}

export async function getMergeBase(
  repoRoot: string,
  baseBranch: string
): Promise<string> {
  const mergeBase = (
    await runGit(repoRoot, ["merge-base", baseBranch, "HEAD"])
  ).trim();
  if (mergeBase.length === 0) {
    throw new GitError(
      `No merge base exists between ${baseBranch} and HEAD.`,
      ["merge-base", baseBranch, "HEAD"],
      1,
      ""
    );
  }
  return mergeBase;
}

export async function getChangedFiles(
  repoRoot: string,
  mergeBase: string
): Promise<ChangedFile[]> {
  const [trackedOutput, untrackedOutput] = await Promise.all([
    runGit(repoRoot, [
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      "--no-color",
      mergeBase
    ]),
    runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
  ]);

  const tracked = parseNameStatus(trackedOutput);
  const trackedPaths = new Set(tracked.map((file) => file.path));
  const untracked = parseNullDelimitedPaths(untrackedOutput)
    .filter((filePath) => !trackedPaths.has(filePath))
    .map<ChangedFile>((filePath) => ({
      status: "??",
      path: filePath,
      untracked: true
    }));

  return [...tracked, ...untracked].sort((left, right) =>
    left.path.localeCompare(right.path)
  );
}

export async function getFileDiff(
  repoRoot: string,
  mergeBase: string,
  file: ChangedFile
): Promise<ParsedFileDiff> {
  if (file.untracked) {
    const filePath = resolveRepositoryPath(repoRoot, file.path);
    if (await isBinaryFile(filePath)) {
      return binaryFileDiff();
    }
    return addedWholeFileDiff();
  }

  const paths = file.oldPath === undefined ? [file.path] : [file.oldPath, file.path];
  const output = await runGit(repoRoot, [
    "diff",
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    "--find-renames",
    mergeBase,
    "--",
    ...paths
  ]);
  return parseUnifiedDiff(output);
}
