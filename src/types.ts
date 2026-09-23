export type GitFileStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U" | "??";

export interface ChangedFile {
  status: GitFileStatus;
  path: string;
  oldPath?: string;
  score?: number;
  untracked: boolean;
}

export interface LineRange {
  start: number;
  end: number;
}

export interface ParsedFileDiff {
  added: LineRange[];
  modified: LineRange[];
  deletedMarkers: number[];
  binary: boolean;
  wholeFileAdded: boolean;
}

export interface ActiveComparison {
  generation: number;
  repoRoot: string;
  currentBranch: string;
  baseBranch: string;
  mergeBase: string;
  changedFiles: ChangedFile[];
  parsedRanges: Map<string, ParsedFileDiff>;
  highlightsVisible: boolean;
}
