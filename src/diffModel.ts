import { structuredPatch } from "diff";
import { isBinaryContent } from "./git";
import { parseUnifiedHunks } from "./diffParser";
import type { ParsedFileDiff } from "./types";

export function buildDiffModel(
  oldPath: string,
  newPath: string,
  baseContent: string,
  currentContent: string
): ParsedFileDiff {
  if (
    isBinaryContent(Buffer.from(baseContent, "utf8")) ||
    isBinaryContent(Buffer.from(currentContent, "utf8"))
  ) {
    return {
      added: [],
      modified: [],
      deletedBlocks: [],
      binary: true,
      wholeFileAdded: false
    };
  }
  if (baseContent === currentContent) {
    return {
      added: [],
      modified: [],
      deletedBlocks: [],
      binary: false,
      wholeFileAdded: false
    };
  }

  const patch = structuredPatch(
    oldPath,
    newPath,
    baseContent.replace(/\r\n/gu, "\n"),
    currentContent.replace(/\r\n/gu, "\n"),
    undefined,
    undefined,
    { context: 0 }
  );
  return parseUnifiedHunks(
    patch.hunks.flatMap((hunk) => [
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      ...hunk.lines
    ])
  );
}
