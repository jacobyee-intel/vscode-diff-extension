import * as vscode from "vscode";
import { renderDeletedBlockHtml, type InsetStyle } from "./insetRenderer";
import { InsetOwnership } from "./insetOwnership";
import type { DeletedBlock } from "./types";

export const PROPOSED_API_INSTRUCTIONS =
  "Expanded deleted rows require VS Code Stable launched with --enable-proposed-api=local.branch-diff. Fully quit every existing VS Code window, then launch: code --enable-proposed-api=local.branch-diff";

export class InsetManager implements vscode.Disposable {
  private readonly ownership =
    new InsetOwnership<vscode.TextEditor, vscode.WebviewEditorInset>();

  public render(
    editor: vscode.TextEditor,
    blocks: readonly DeletedBlock[],
    style: InsetStyle,
    isCurrent: () => boolean
  ): void {
    const createInset = vscode.window.createWebviewTextEditorInset;
    if (typeof createInset !== "function") {
      throw new Error(PROPOSED_API_INSTRUCTIONS);
    }

    try {
      this.ownership.replace(
        editor,
        (candidate) => {
          for (const block of blocks) {
            const inset = createInset(
              editor,
              block.afterLine,
              block.lines.length,
              {
                enableScripts: false,
                localResourceRoots: []
              }
            );
            candidate.add(inset);
            inset.webview.options = {
              enableScripts: false,
              localResourceRoots: []
            };
            inset.webview.html = renderDeletedBlockHtml(block, style);
          }
        },
        isCurrent
      );
    } catch (error) {
      if (
        error instanceof Error &&
        /proposed api|editorInsets|enable-proposed-api/iu.test(error.message)
      ) {
        throw new Error(PROPOSED_API_INSTRUCTIONS, { cause: error });
      }
      throw error;
    }
  }

  public clearEditor(editor: vscode.TextEditor): void {
    this.ownership.clearEditor(editor);
  }

  public clearDocument(document: vscode.TextDocument): void {
    this.ownership.clearWhere((editor) => editor.document === document);
  }

  public retainEditors(editors: readonly vscode.TextEditor[]): void {
    const visible = new Set(editors);
    this.ownership.clearWhere((editor) => !visible.has(editor));
  }

  public clearAll(): void {
    this.ownership.clearAll();
  }

  public dispose(): void {
    this.clearAll();
  }
}
