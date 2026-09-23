import type { ActiveComparison, ChangedFile } from "./types";

export interface ComparisonReplacementData {
  currentBranch: string;
  mergeBase: string;
  changedFiles: ChangedFile[];
}

export function createComparisonReplacement(
  previous: ActiveComparison,
  generation: number,
  data: ComparisonReplacementData
): ActiveComparison {
  return {
    generation,
    repoRoot: previous.repoRoot,
    currentBranch: data.currentBranch,
    baseBranch: previous.baseBranch,
    mergeBase: data.mergeBase,
    changedFiles: data.changedFiles,
    baseContents: new Map(),
    highlightsVisible: previous.highlightsVisible,
    expandedDeletionsVisible: previous.expandedDeletionsVisible
  };
}
