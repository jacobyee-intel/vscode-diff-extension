import * as vscode from "vscode";
import { ComparisonController } from "./comparisonController";

export function activate(context: vscode.ExtensionContext): void {
  const controller = new ComparisonController(context);
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand(
      "branchDiff.startComparison",
      async () => controller.startComparison()
    ),
    vscode.commands.registerCommand(
      "branchDiff.browseChangedFiles",
      async () => controller.browseChangedFiles()
    ),
    vscode.commands.registerCommand(
      "branchDiff.toggleHighlights",
      async () => controller.toggleHighlights()
    ),
    vscode.commands.registerCommand(
      "branchDiff.refreshComparison",
      async () => controller.refreshComparison()
    ),
    vscode.commands.registerCommand("branchDiff.clearComparison", () => {
      controller.clearComparison();
    })
  );
}

export function deactivate(): void {
  // VS Code disposes context subscriptions.
}
