import * as vscode from "vscode";
import { ComparisonController } from "./comparisonController";
import { PROPOSED_API_INSTRUCTIONS } from "./insetManager";

interface InsetSmokeResult {
  readonly createdInsets: number;
  readonly disposableHandles: number;
}

async function runInsetSmokeTest(): Promise<InsetSmokeResult> {
  const document = await vscode.workspace.openTextDocument({
    content: "first\nsecond\nthird\n",
    language: "plaintext"
  });
  const editor = await vscode.window.showTextDocument(document);
  const createInset = vscode.window.createWebviewTextEditorInset;
  if (typeof createInset !== "function") {
    throw new Error(PROPOSED_API_INSTRUCTIONS);
  }

  const insets: vscode.WebviewEditorInset[] = [];
  let disposableHandles = 0;
  try {
    for (const afterLine of [-1, 1]) {
      let inset: vscode.WebviewEditorInset;
      try {
        inset = createInset(editor, afterLine, 1, {
          enableScripts: false,
          localResourceRoots: []
        });
      } catch (error) {
        throw new Error(PROPOSED_API_INSTRUCTIONS, { cause: error });
      }
      insets.push(inset);
      if (typeof inset.dispose === "function") {
        disposableHandles += 1;
      }
      inset.webview.options = {
        enableScripts: false,
        localResourceRoots: []
      };
      inset.webview.html =
        "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'\"></head><body>Branch Diff inset smoke</body></html>";
    }
  } finally {
    for (const inset of insets) {
      inset.dispose();
    }
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  }

  return {
    createdInsets: insets.length,
    disposableHandles
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new ComparisonController(context);
  const subscriptions: vscode.Disposable[] = [
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
      "branchDiff.toggleExpandedDeletions",
      async () => controller.toggleExpandedDeletions()
    ),
    vscode.commands.registerCommand(
      "branchDiff.refreshComparison",
      async () => controller.refreshComparison()
    ),
    vscode.commands.registerCommand("branchDiff.clearComparison", () => {
      controller.clearComparison();
    })
  ];
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    subscriptions.push(
      vscode.commands.registerCommand(
        "branchDiff.test.runInsetSmoke",
        runInsetSmokeTest
      )
    );
  }
  context.subscriptions.push(...subscriptions);
}

export function deactivate(): void {
  // VS Code disposes context subscriptions.
}
