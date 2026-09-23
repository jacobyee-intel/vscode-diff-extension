import type { LineRange, ParsedFileDiff } from "./types";

const HUNK_HEADER =
  /^@@ -(?<oldStart>\d+)(?:,(?<oldCount>\d+))? \+(?<newStart>\d+)(?:,(?<newCount>\d+))? @@/;

function addRange(ranges: LineRange[], start: number, length: number): void {
  if (length <= 0) {
    return;
  }

  ranges.push({ start: Math.max(0, start), end: Math.max(0, start) + length });
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

export function parseUnifiedDiff(diff: string): ParsedFileDiff {
  const added: LineRange[] = [];
  const modified: LineRange[] = [];
  const deletedMarkers: number[] = [];
  let binary = false;

  for (const line of diff.split(/\r?\n/u)) {
    if (
      line.startsWith("Binary files ") ||
      line.startsWith("Binary file ") ||
      line.startsWith("GIT binary patch")
    ) {
      binary = true;
      continue;
    }

    const match = HUNK_HEADER.exec(line);
    if (match?.groups === undefined) {
      continue;
    }

    const oldCount = Number(match.groups.oldCount ?? "1");
    const newStart = Number(match.groups.newStart);
    const newCount = Number(match.groups.newCount ?? "1");
    const newStartIndex = Math.max(0, newStart - 1);

    if (oldCount === 0) {
      addRange(added, newStartIndex, newCount);
      continue;
    }

    const modifiedCount = Math.min(oldCount, newCount);
    addRange(modified, newStartIndex, modifiedCount);

    if (newCount > oldCount) {
      addRange(added, newStartIndex + oldCount, newCount - oldCount);
    }

    if (oldCount > newCount) {
      const nearestSurvivingLine = Math.max(
        0,
        newStart + Math.max(newCount, 1) - 2
      );
      deletedMarkers.push(nearestSurvivingLine);
    }
  }

  return {
    added: mergeRanges(added),
    modified: mergeRanges(modified),
    deletedMarkers: [...new Set(deletedMarkers)].sort(
      (left, right) => left - right
    ),
    binary,
    wholeFileAdded: false
  };
}

export function addedWholeFileDiff(): ParsedFileDiff {
  return {
    added: [],
    modified: [],
    deletedMarkers: [],
    binary: false,
    wholeFileAdded: true
  };
}

export function binaryFileDiff(): ParsedFileDiff {
  return {
    added: [],
    modified: [],
    deletedMarkers: [],
    binary: true,
    wholeFileAdded: false
  };
}
