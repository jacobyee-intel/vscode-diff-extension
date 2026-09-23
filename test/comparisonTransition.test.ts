import assert from "node:assert/strict";
import test from "node:test";
import { createComparisonReplacement } from "../src/comparisonTransition";
import type { ActiveComparison } from "../src/types";

function comparison(): ActiveComparison {
  return {
    generation: 4,
    repoRoot: "/repo",
    currentBranch: "feature-old",
    baseBranch: "main",
    mergeBase: "old-base",
    changedFiles: [
      { status: "M", path: "old.txt", untracked: false }
    ],
    baseContents: new Map([["old.txt", "cached"]]),
    highlightsVisible: false,
    expandedDeletionsVisible: true
  };
}

void test("builds refresh replacement without mutating valid prior state", () => {
  const previous = comparison();
  const replacement = createComparisonReplacement(previous, 5, {
    currentBranch: "feature-new",
    mergeBase: "new-base",
    changedFiles: [
      { status: "A", path: "new.txt", untracked: false }
    ]
  });

  assert.equal(previous.generation, 4);
  assert.equal(previous.mergeBase, "old-base");
  assert.deepEqual([...previous.baseContents], [["old.txt", "cached"]]);
  assert.equal(replacement.generation, 5);
  assert.equal(replacement.mergeBase, "new-base");
  assert.deepEqual(replacement.changedFiles.map((file) => file.path), [
    "new.txt"
  ]);
  assert.notEqual(replacement.baseContents, previous.baseContents);
  assert.equal(replacement.baseContents.size, 0);
  assert.equal(replacement.highlightsVisible, false);
  assert.equal(replacement.expandedDeletionsVisible, true);
});
