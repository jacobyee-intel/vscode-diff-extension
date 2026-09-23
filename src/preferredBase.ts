const COMMON_BASE_BRANCHES = ["main", "master", "develop"] as const;

export function selectPreferredBase(
  branches: readonly string[],
  recentBase: string | undefined
): string | undefined {
  if (branches.length === 0) {
    return undefined;
  }

  const branchSet = new Set(branches);
  if (recentBase !== undefined && branchSet.has(recentBase)) {
    return recentBase;
  }

  for (const branch of COMMON_BASE_BRANCHES) {
    if (branchSet.has(branch)) {
      return branch;
    }
  }

  return [...branches].sort((left, right) => left.localeCompare(right))[0];
}
