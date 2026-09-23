import type {
  DeletedBlock,
  LineRange,
  ParsedFileDiff
} from "./types";

const HUNK_HEADER =
  /^@@ -(?<oldStart>\d+)(?:,(?<oldCount>\d+))? \+(?<newStart>\d+)(?:,(?<newCount>\d+))? @@(?: .*)?$/u;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

export interface DiffTarget {
  oldPath: string;
  newPath: string;
}

function addRange(ranges: LineRange[], start: number, length: number): void {
  if (length > 0) {
    ranges.push({ start: Math.max(0, start), end: Math.max(0, start) + length });
  }
}

function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function emptyDiff(binary = false): ParsedFileDiff {
  return {
    added: [],
    modified: [],
    deletedBlocks: [],
    binary,
    wholeFileAdded: false
  };
}

function splitLines(diff: string): string[] {
  const lines = diff.replace(/\r\n/gu, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function decodeGitQuotedPath(token: string): string {
  if (!token.startsWith("\"") || !token.endsWith("\"")) {
    throw new Error(`Malformed Git quoted path: ${token}`);
  }
  const bytes: Buffer[] = [];
  const literal: string[] = [];
  const flushLiteral = (): void => {
    if (literal.length > 0) {
      bytes.push(Buffer.from(literal.join(""), "utf8"));
      literal.length = 0;
    }
  };
  const escapes: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
    "\"": 0x22,
    "\\": 0x5c
  };

  for (let index = 1; index < token.length - 1; index += 1) {
    const character = token[index] as string;
    if (character !== "\\") {
      literal.push(character);
      continue;
    }
    flushLiteral();
    const escaped = token[++index];
    if (escaped === undefined || index >= token.length - 1) {
      throw new Error(`Malformed Git quoted path: ${token}`);
    }
    if (/[0-7]/u.test(escaped)) {
      let octal = escaped;
      for (
        let count = 1;
        count < 3 && /[0-7]/u.test(token[index + 1] ?? "");
        count += 1
      ) {
        octal += token[++index];
      }
      const byte = Number.parseInt(octal, 8);
      if (byte > 0xff) {
        throw new Error(`Invalid Git path byte escape: \\${octal}`);
      }
      bytes.push(Buffer.from([byte]));
      continue;
    }
    const value = escapes[escaped];
    if (value === undefined) {
      throw new Error(`Unsupported Git path escape: \\${escaped}`);
    }
    bytes.push(Buffer.from([value]));
  }
  flushLiteral();
  return Buffer.concat(bytes).toString("utf8");
}

function readQuotedToken(
  value: string,
  start: number
): { token: string; end: number } {
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\"" && !escaped) {
      return { token: value.slice(start, index + 1), end: index + 1 };
    }
    if (character === "\\" && !escaped) {
      escaped = true;
    } else {
      escaped = false;
    }
  }
  throw new Error(`Malformed diff section header: ${value}`);
}

function parseEscapedSectionHeader(line: string): DiffTarget | undefined {
  const prefix = "diff --git ";
  const value = line.slice(prefix.length);
  if (!value.includes("\"")) {
    return undefined;
  }
  let oldPath: string;
  let newValue: string;
  if (value.startsWith("\"")) {
    const oldToken = readQuotedToken(value, 0);
    if (value[oldToken.end] !== " ") {
      throw new Error(`Malformed diff section header: ${line}`);
    }
    oldPath = decodeGitQuotedPath(oldToken.token);
    newValue = value.slice(oldToken.end + 1);
  } else {
    const separator = value.indexOf(" \"");
    if (separator < 0) {
      throw new Error(`Malformed diff section header: ${line}`);
    }
    oldPath = value.slice(0, separator);
    newValue = value.slice(separator + 1);
  }
  let newPath: string;
  if (newValue.startsWith("\"")) {
    const newToken = readQuotedToken(newValue, 0);
    if (newToken.end !== newValue.length) {
      throw new Error(`Malformed diff section header: ${line}`);
    }
    newPath = decodeGitQuotedPath(newToken.token);
  } else {
    if (newValue.includes("\"")) {
      throw new Error(`Malformed diff section header: ${line}`);
    }
    newPath = newValue;
  }
  if (!oldPath.startsWith("a/") || !newPath.startsWith("b/")) {
    throw new Error(`Malformed diff section header: ${line}`);
  }
  return { oldPath: oldPath.slice(2), newPath: newPath.slice(2) };
}

function headerMatches(line: string, target: DiffTarget): boolean {
  const escaped = parseEscapedSectionHeader(line);
  return escaped === undefined
    ? line === `diff --git a/${target.oldPath} b/${target.newPath}`
    : escaped.oldPath === target.oldPath && escaped.newPath === target.newPath;
}

function isSectionHeader(line: string): boolean {
  if (!line.startsWith("diff --git ")) {
    return false;
  }
  if (line.includes("\"")) {
    parseEscapedSectionHeader(line);
    return true;
  }
  const value = line.slice("diff --git ".length);
  if (
    !value.startsWith("a/") ||
    !value.includes(" b/") ||
    value.endsWith(" b/")
  ) {
    throw new Error(`Malformed diff section header: ${line}`);
  }
  return true;
}

function selectSection(lines: readonly string[], target: DiffTarget): string[] {
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (isSectionHeader(line) && headerMatches(line, target)) {
      starts.push(index);
    }
  }
  if (starts.length !== 1) {
    throw new Error(
      starts.length === 0
        ? `Diff does not contain the requested file section: ${target.newPath}`
        : `Diff contains multiple matching file sections: ${target.newPath}`
    );
  }
  const start = starts[0] as number;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isSectionHeader(lines[index] as string)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end);
}

function isFileMetadata(line: string): boolean {
  return /^(?:index |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |--- |\+\+\+ )/u.test(
    line
  );
}

export function parseUnifiedHunks(lines: readonly string[]): ParsedFileDiff {
  const added: LineRange[] = [];
  const modified: LineRange[] = [];
  const deletedBlocks: DeletedBlock[] = [];
  let index = 0;
  let sawHunk = false;

  while (index < lines.length) {
    const line = lines[index] as string;
    if (line === NO_NEWLINE_MARKER) {
      throw new Error("Misplaced or duplicate no-newline marker.");
    }
    const match = HUNK_HEADER.exec(line);
    if (match?.groups === undefined) {
      throw new Error(
        line.startsWith("@@")
          ? `Malformed hunk header: ${line}`
          : `Unexpected content outside hunk: ${line}`
      );
    }
    sawHunk = true;
    const oldCount = Number(match.groups.oldCount ?? "1");
    const oldStart = Number(match.groups.oldStart);
    const newStart = Number(match.groups.newStart);
    const newCount = Number(match.groups.newCount ?? "1");
    if (
      !Number.isSafeInteger(oldStart) ||
      !Number.isSafeInteger(newStart) ||
      !Number.isSafeInteger(oldCount) ||
      !Number.isSafeInteger(newCount)
    ) {
      throw new Error(`Invalid hunk counts: ${line}`);
    }

    let oldSeen = 0;
    let newSeen = 0;
    let oldLine = oldStart;
    let newLineIndex = newCount === 0 ? newStart : Math.max(0, newStart - 1);
    let pendingDeleted: { originalStartLine: number; lines: string[] } | undefined;
    let pendingAddedStart: number | undefined;
    let pendingAddedCount = 0;
    let markerAllowed = false;

    const flushChangeGroup = (): void => {
      const deletedCount = pendingDeleted?.lines.length ?? 0;
      const paired = Math.min(deletedCount, pendingAddedCount);
      if (pendingDeleted !== undefined) {
        deletedBlocks.push({
          afterLine:
            pendingAddedStart === undefined
              ? newLineIndex - 1
              : pendingAddedStart - 1,
          originalStartLine: pendingDeleted.originalStartLine,
          lines: pendingDeleted.lines
        });
      }
      if (pendingAddedStart !== undefined) {
        addRange(modified, pendingAddedStart, paired);
        addRange(added, pendingAddedStart + paired, pendingAddedCount - paired);
      }
      pendingDeleted = undefined;
      pendingAddedStart = undefined;
      pendingAddedCount = 0;
    };

    index += 1;
    while (oldSeen < oldCount || newSeen < newCount) {
      const body = lines[index];
      if (body === undefined || body.startsWith("@@")) {
        throw new Error(`Truncated hunk beginning at: ${line}`);
      }
      if (body === NO_NEWLINE_MARKER) {
        if (!markerAllowed) {
          throw new Error("Misplaced or duplicate no-newline marker.");
        }
        markerAllowed = false;
        index += 1;
        continue;
      }
      const prefix = body[0];
      const text = body.slice(1);
      markerAllowed = true;
      if (prefix === " ") {
        flushChangeGroup();
        oldSeen += 1;
        newSeen += 1;
        oldLine += 1;
        newLineIndex += 1;
      } else if (prefix === "-") {
        pendingDeleted ??= { originalStartLine: oldLine, lines: [] };
        pendingDeleted.lines.push(text);
        oldSeen += 1;
        oldLine += 1;
      } else if (prefix === "+") {
        pendingAddedStart ??= newLineIndex;
        pendingAddedCount += 1;
        newSeen += 1;
        newLineIndex += 1;
      } else {
        throw new Error(`Invalid hunk body line: ${body}`);
      }
      if (oldSeen > oldCount || newSeen > newCount) {
        throw new Error(`Hunk count overflow at: ${line}`);
      }
      index += 1;
    }
    if (lines[index] === NO_NEWLINE_MARKER) {
      if (!markerAllowed) {
        throw new Error("Misplaced or duplicate no-newline marker.");
      }
      index += 1;
    }
    flushChangeGroup();
  }

  if (!sawHunk) {
    throw new Error("Text diff has no hunks.");
  }
  return {
    added: mergeRanges(added),
    modified: mergeRanges(modified),
    deletedBlocks,
    binary: false,
    wholeFileAdded: false
  };
}

export function parseUnifiedDiff(
  diff: string,
  target: DiffTarget
): ParsedFileDiff {
  const allLines = splitLines(diff);
  if (allLines.length === 0) {
    return emptyDiff();
  }
  const lines = selectSection(allLines, target);
  if (
    lines.some(
      (line) =>
        line.startsWith("Binary files ") ||
        line.startsWith("Binary file ") ||
        line === "GIT binary patch"
    )
  ) {
    return emptyDiff(true);
  }

  let index = 1;
  while (index < lines.length && isFileMetadata(lines[index] as string)) {
    index += 1;
  }
  if (index >= lines.length) {
    throw new Error(`Text diff has no hunks for: ${target.newPath}`);
  }
  return parseUnifiedHunks(lines.slice(index));
}

export function addedWholeFileDiff(): ParsedFileDiff {
  return { ...emptyDiff(), wholeFileAdded: true };
}

export function binaryFileDiff(): ParsedFileDiff {
  return emptyDiff(true);
}
