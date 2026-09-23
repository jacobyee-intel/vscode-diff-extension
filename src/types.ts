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

export interface DeletedBlock {
  afterLine: number;
  originalStartLine: number;
  lines: string[];
}

export interface ParsedFileDiff {
  added: LineRange[];
  modified: LineRange[];
  deletedBlocks: DeletedBlock[];
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
  baseContents: Map<string, string>;
  highlightsVisible: boolean;
  expandedDeletionsVisible: boolean;
}
