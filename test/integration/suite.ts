import assert from "node:assert/strict";
import * as vscode from "vscode";
import { PROPOSED_API_INSTRUCTIONS } from "../../src/insetManager";

interface InsetSmokeResult {
  readonly createdInsets: number;
  readonly disposableHandles: number;
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("local.branch-diff");
  assert.ok(extension, "Branch Diff extension was not discovered");
  await extension.activate();
  assert.equal(extension.isActive, true, "Branch Diff extension did not activate");

  const mode = process.env.BRANCH_DIFF_SMOKE_MODE;
  assert.ok(
    mode === "proposed" || mode === "no-flag",
    `Unexpected smoke mode: ${String(mode)}`
  );

  if (mode === "proposed") {
    const result = await vscode.commands.executeCommand<InsetSmokeResult>(
      "branchDiff.test.runInsetSmoke"
    );
    assert.deepEqual(result, {
      createdInsets: 2,
      disposableHandles: 2
    });
    return;
  }

  await assert.rejects(
    Promise.resolve(
      vscode.commands.executeCommand("branchDiff.test.runInsetSmoke")
    ),
    (error: unknown) =>
      error instanceof Error && error.message === PROPOSED_API_INSTRUCTIONS,
    "The no-flag operation must fail with the actionable proposed-API message"
  );
}
