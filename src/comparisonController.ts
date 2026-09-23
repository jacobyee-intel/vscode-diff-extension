import path from "node:path";
import * as vscode from "vscode";
import {
  findRepositoryRoot,
  getChangedFiles,
  getCurrentBranch,
  getFileDiff,
  getLocalBranches,
  getMergeBase,
  GitError,
  localBranchExists,
  resolveRepositoryPath
} from "./git";
import { selectPreferredBase } from "./preferredBase";
import type {
  ActiveComparison,
  ChangedFile,
  LineRange,
  ParsedFileDiff
} from "./types";

interface BranchQuickPickItem extends vscode.QuickPickItem {
  branch: string;
}

interface FileQuickPickItem extends vscode.QuickPickItem {
  file: ChangedFile;
}

const STATUS_DESCRIPTIONS: Record<string, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  U: "Unmerged",
  "??": "Untracked"
};

export class ComparisonController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly addedDecoration: vscode.TextEditorDecorationType;
  private readonly modifiedDecoration: vscode.TextEditorDecorationType;
  private readonly deletedDecoration: vscode.TextEditorDecorationType;
  private readonly statusBar: vscode.StatusBarItem;
  private comparison: ActiveComparison | undefined;
  private generation = 0;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.addedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor(
        "branchDiff.addedLineBackground"
      ),
      overviewRulerColor: new vscode.ThemeColor(
        "branchDiff.addedLineBackground"
      ),
      overviewRulerLane: vscode.OverviewRulerLane.Left
    });
    this.modifiedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor(
        "branchDiff.modifiedLineBackground"
      ),
      overviewRulerColor: new vscode.ThemeColor(
        "branchDiff.modifiedLineBackground"
      ),
      overviewRulerLane: vscode.OverviewRulerLane.Left
    });
    this.deletedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderStyle: "solid",
      borderWidth: "0 0 0 3px",
      borderColor: new vscode.ThemeColor(
        "branchDiff.deletedLineForeground"
      ),
      overviewRulerColor: new vscode.ThemeColor(
        "branchDiff.deletedLineForeground"
      ),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      after: {
        contentText: "  -",
        color: new vscode.ThemeColor("branchDiff.deletedLineForeground")
      }
    });
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBar.command = "branchDiff.browseChangedFiles";
    this.statusBar.tooltip = "Browse files changed relative to the base branch";

    this.disposables.push(
      this.addedDecoration,
      this.modifiedDecoration,
      this.deletedDecoration,
      this.statusBar,
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          void this.applyDecorations(editor);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        void this.refreshSavedFile(document);
      })
    );
  }

  public dispose(): void {
    this.clearComparison();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  public async startComparison(): Promise<void> {
    const generation = this.invalidateAsyncOperations(this.comparison);
    try {
      const repoRoot = await this.chooseRepository();
      if (repoRoot === undefined || !this.isGenerationCurrent(generation)) {
        return;
      }

      const currentBranch = await getCurrentBranch(repoRoot);
      if (!this.isGenerationCurrent(generation)) {
        return;
      }
      const branches = (await getLocalBranches(repoRoot)).filter(
        (branch) => branch !== currentBranch
      );
      if (!this.isGenerationCurrent(generation)) {
        return;
      }
      if (branches.length === 0) {
        void vscode.window.showInformationMessage(
          "Branch Diff: No alternative local branches are available."
        );
        return;
      }

      const stateKey = this.lastBaseStateKey(repoRoot);
      const recentBase = this.context.workspaceState.get<string>(stateKey);
      const preferred = selectPreferredBase(branches, recentBase);
      const baseBranch = await this.chooseBaseBranch(branches, preferred);
      if (
        baseBranch === undefined ||
        !this.isGenerationCurrent(generation)
      ) {
        return;
      }

      const mergeBase = await getMergeBase(repoRoot, baseBranch);
      if (!this.isGenerationCurrent(generation)) {
        return;
      }
      const changedFiles = await getChangedFiles(repoRoot, mergeBase);
      if (!this.isGenerationCurrent(generation)) {
        return;
      }
      const comparison: ActiveComparison = {
        generation,
        repoRoot,
        currentBranch,
        baseBranch,
        mergeBase,
        changedFiles,
        parsedRanges: new Map(),
        highlightsVisible: true
      };
      this.comparison = comparison;
      this.clearDecorations();
      await this.context.workspaceState.update(stateKey, baseBranch);
      if (!this.isComparisonCurrent(comparison, generation)) {
        return;
      }
      this.updateStatusBar();
      await this.applyToVisibleEditors(comparison, generation);
      if (!this.isComparisonCurrent(comparison, generation)) {
        return;
      }
      await this.browseChangedFiles();
    } catch (error) {
      if (this.isGenerationCurrent(generation)) {
        this.showError("Unable to start comparison", error);
      }
    }
  }

  public async browseChangedFiles(): Promise<void> {
    const comparison = this.comparison;
    if (comparison === undefined) {
      void vscode.window.showInformationMessage(
        "Branch Diff: Start a comparison first."
      );
      return;
    }
    if (comparison.changedFiles.length === 0) {
      void vscode.window.showInformationMessage(
        `Branch Diff: No changes relative to ${comparison.baseBranch}.`
      );
      return;
    }
    const generation = comparison.generation;

    const selected = await this.chooseChangedFile(comparison.changedFiles);
    if (
      selected === undefined ||
      !this.isFileCurrent(comparison, generation, selected)
    ) {
      return;
    }
    await this.openChangedFile(selected);
  }

  public async toggleHighlights(): Promise<void> {
    if (this.comparison === undefined) {
      void vscode.window.showInformationMessage(
        "Branch Diff: Start a comparison first."
      );
      return;
    }

    const comparison = this.comparison;
    const generation = this.invalidateAsyncOperations(comparison);
    comparison.highlightsVisible = !comparison.highlightsVisible;
    if (!comparison.highlightsVisible) {
      this.clearDecorations();
    } else {
      await this.applyToVisibleEditors(comparison, generation);
    }
    if (this.isComparisonCurrent(comparison, generation)) {
      this.updateStatusBar();
    }
  }

  public async refreshComparison(): Promise<void> {
    const comparison = this.comparison;
    if (comparison === undefined) {
      void vscode.window.showInformationMessage(
        "Branch Diff: Start a comparison first."
      );
      return;
    }

    const generation = this.invalidateAsyncOperations(comparison);
    try {
      const branchExists = await localBranchExists(
        comparison.repoRoot,
        comparison.baseBranch
      );
      if (!this.isComparisonCurrent(comparison, generation)) {
        return;
      }
      if (!branchExists) {
        throw new Error(
          `The base branch '${comparison.baseBranch}' no longer exists locally.`
        );
      }

      const currentBranch = await getCurrentBranch(comparison.repoRoot);
      if (!this.isComparisonCurrent(comparison, generation)) {
        return;
      }
      const mergeBase = await getMergeBase(
        comparison.repoRoot,
        comparison.baseBranch
      );
      if (!this.isComparisonCurrent(comparison, generation)) {
        return;
      }
      const changedFiles = await getChangedFiles(
        comparison.repoRoot,
        mergeBase
      );
      if (!this.isComparisonCurrent(comparison, generation)) {
        return;
      }

      comparison.currentBranch = currentBranch;
      comparison.mergeBase = mergeBase;
      comparison.changedFiles = changedFiles;
      comparison.parsedRanges.clear();
      this.clearDecorations();
      await this.applyToVisibleEditors(comparison, generation);
      if (!this.isComparisonCurrent(comparison, generation)) {
        return;
      }
      this.updateStatusBar();

      if (comparison.changedFiles.length === 0) {
        void vscode.window.showInformationMessage(
          `Branch Diff: No changes relative to ${comparison.baseBranch}.`
        );
      }
    } catch (error) {
      if (this.isComparisonCurrent(comparison, generation)) {
        this.showError("Unable to refresh comparison", error);
      }
    }
  }

  public clearComparison(): void {
    this.invalidateAsyncOperations();
    this.comparison = undefined;
    this.clearDecorations();
    this.statusBar.hide();
  }

  private async chooseRepository(): Promise<string | undefined> {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri?.scheme === "file") {
      const activeRoot = await findRepositoryRoot(
        path.dirname(activeUri.fsPath)
      );
      if (activeRoot !== undefined) {
        return activeRoot;
      }
    }

    const roots = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== "file") {
        continue;
      }
      const root = await findRepositoryRoot(folder.uri.fsPath);
      if (root !== undefined) {
        roots.add(root);
      }
    }

    if (roots.size === 0) {
      void vscode.window.showErrorMessage(
        "Branch Diff: No Git repository was found for the active editor or workspace."
      );
      return undefined;
    }
    if (roots.size === 1) {
      return [...roots][0];
    }

    const items = [...roots]
      .sort((left, right) => left.localeCompare(right))
      .map((repoRoot) => ({
        label: path.basename(repoRoot),
        description: repoRoot,
        repoRoot
      }));
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: "Choose a Git repository",
      matchOnDescription: true
    });
    return selected?.repoRoot;
  }

  private async chooseBaseBranch(
    branches: readonly string[],
    preferred: string | undefined
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      const quickPick = vscode.window.createQuickPick<BranchQuickPickItem>();
      quickPick.title = "Branch Diff: Choose Base Branch";
      quickPick.placeholder =
        "Compare the working branch and working tree against a local branch";
      quickPick.matchOnDescription = true;
      quickPick.items = branches.map((branch) => ({
        label: `$(git-branch) ${branch}`,
        branch
      }));

      const preferredItem = quickPick.items.find(
        (item) => item.branch === preferred
      );
      if (preferredItem !== undefined) {
        quickPick.activeItems = [preferredItem];
      }

      let completed = false;
      const acceptDisposable = quickPick.onDidAccept(() => {
        const item = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
        if (item === undefined) {
          return;
        }
        completed = true;
        quickPick.hide();
        resolve(item.branch);
      });
      const hideDisposable = quickPick.onDidHide(() => {
        acceptDisposable.dispose();
        hideDisposable.dispose();
        quickPick.dispose();
        if (!completed) {
          resolve(undefined);
        }
      });
      quickPick.show();
    });
  }

  private async chooseChangedFile(
    files: readonly ChangedFile[]
  ): Promise<ChangedFile | undefined> {
    return new Promise((resolve) => {
      const quickPick = vscode.window.createQuickPick<FileQuickPickItem>();
      quickPick.title = "Branch Diff: Changed Files";
      quickPick.placeholder = "Search changed files";
      quickPick.matchOnDescription = true;
      quickPick.matchOnDetail = true;
      quickPick.items = files.map((file) => {
        const renamedPath =
          file.oldPath === undefined
            ? file.path
            : `${file.oldPath} -> ${file.path}`;
        return {
          label: renamedPath,
          description:
            file.status === "D"
              ? "Deleted (not selectable)"
              : `${file.status} ${STATUS_DESCRIPTIONS[file.status] ?? "Changed"}`,
          detail: file.path,
          file
        };
      });

      let completed = false;
      const acceptDisposable = quickPick.onDidAccept(() => {
        const item = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
        if (item === undefined) {
          return;
        }
        if (item.file.status === "D") {
          void vscode.window.showInformationMessage(
            "Branch Diff: Deleted files cannot be opened as editable workspace files."
          );
          return;
        }
        completed = true;
        quickPick.hide();
        resolve(item.file);
      });
      const hideDisposable = quickPick.onDidHide(() => {
        acceptDisposable.dispose();
        hideDisposable.dispose();
        quickPick.dispose();
        if (!completed) {
          resolve(undefined);
        }
      });
      quickPick.show();
    });
  }

  private async openChangedFile(file: ChangedFile): Promise<void> {
    const comparison = this.comparison;
    if (comparison === undefined) {
      return;
    }
    const generation = comparison.generation;

    try {
      const uri = vscode.Uri.file(
        resolveRepositoryPath(comparison.repoRoot, file.path)
      );
      const document = await vscode.workspace.openTextDocument(uri);
      if (!this.isFileCurrent(comparison, generation, file)) {
        return;
      }
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn:
          vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active,
        preserveFocus: false,
        preview: false
      });
      if (!this.isEditorTargetCurrent(editor, comparison, generation, file)) {
        return;
      }
      const parsed = await this.getParsedDiff(
        editor,
        comparison,
        generation,
        file
      );
      if (parsed === undefined) {
        return;
      }
      if (parsed.binary) {
        this.clearEditorDecorations(editor);
        void vscode.window.showInformationMessage(
          `Branch Diff: ${file.path} is binary; line highlights are unavailable.`
        );
        return;
      }

      await this.applyDecorations(editor, comparison, generation);
      if (!this.isEditorTargetCurrent(editor, comparison, generation, file)) {
        return;
      }
      const firstLine = this.firstChangedLine(parsed);
      if (firstLine !== undefined) {
        const line = Math.min(firstLine, Math.max(0, document.lineCount - 1));
        const range = new vscode.Range(line, 0, line, 0);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        editor.selection = new vscode.Selection(range.start, range.start);
      }
    } catch (error) {
      if (this.isFileCurrent(comparison, generation, file)) {
        this.showError(`Unable to open ${file.path}`, error);
      }
    }
  }

  private async applyToVisibleEditors(
    comparison: ActiveComparison,
    generation: number
  ): Promise<void> {
    await Promise.all(
      vscode.window.visibleTextEditors.map((editor) =>
        this.applyDecorations(editor, comparison, generation)
      )
    );
  }

  private async applyDecorations(
    editor: vscode.TextEditor,
    expectedComparison?: ActiveComparison,
    expectedGeneration?: number
  ): Promise<void> {
    const comparison = expectedComparison ?? this.comparison;
    const generation = expectedGeneration ?? comparison?.generation;
    if (
      expectedComparison !== undefined &&
      expectedGeneration !== undefined &&
      !this.isComparisonCurrent(expectedComparison, expectedGeneration)
    ) {
      return;
    }
    if (
      comparison === undefined ||
      generation === undefined ||
      !comparison.highlightsVisible ||
      editor.document.uri.scheme !== "file"
    ) {
      this.clearEditorDecorations(editor);
      return;
    }

    const relativePath = this.relativeRepositoryPath(
      comparison,
      editor.document.uri.fsPath
    );
    if (relativePath === undefined) {
      this.clearEditorDecorations(editor);
      return;
    }

    const file = comparison.changedFiles.find(
      (candidate) => candidate.path === relativePath && candidate.status !== "D"
    );
    if (file === undefined) {
      this.clearEditorDecorations(editor);
      return;
    }

    try {
      const parsed = await this.getParsedDiff(
        editor,
        comparison,
        generation,
        file
      );
      if (parsed === undefined) {
        return;
      }
      if (!this.isDecorationCurrent(editor, comparison, generation, file)) {
        return;
      }
      if (parsed.binary) {
        this.clearEditorDecorations(editor);
        return;
      }

      const fullDocumentRange = [
        new vscode.Range(
          0,
          0,
          Math.max(0, editor.document.lineCount - 1),
          Number.MAX_SAFE_INTEGER
        )
      ];
      editor.setDecorations(
        this.addedDecoration,
        parsed.wholeFileAdded
          ? fullDocumentRange
          : this.toEditorRanges(parsed.added, editor.document)
      );
      editor.setDecorations(
        this.modifiedDecoration,
        this.toEditorRanges(parsed.modified, editor.document)
      );
      editor.setDecorations(
        this.deletedDecoration,
        parsed.deletedMarkers.map((line) => {
          const safeLine = Math.min(
            Math.max(0, line),
            Math.max(0, editor.document.lineCount - 1)
          );
          return new vscode.Range(safeLine, 0, safeLine, 0);
        })
      );
    } catch (error) {
      if (this.isDecorationCurrent(editor, comparison, generation, file)) {
        this.clearEditorDecorations(editor);
        this.showError(`Unable to decorate ${relativePath}`, error);
      }
    }
  }

  private toEditorRanges(
    ranges: readonly LineRange[],
    document: vscode.TextDocument
  ): vscode.Range[] {
    const lastLine = Math.max(0, document.lineCount - 1);
    return ranges
      .filter((range) => range.end > 0 && range.start <= lastLine)
      .map((range) => {
        const start = Math.min(Math.max(0, range.start), lastLine);
        const end = Math.min(Math.max(start, range.end - 1), lastLine);
        return new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER);
      });
  }

  private async getParsedDiff(
    editor: vscode.TextEditor,
    comparison: ActiveComparison,
    generation: number,
    file: ChangedFile
  ): Promise<ParsedFileDiff | undefined> {
    const cached = comparison.parsedRanges.get(file.path);
    if (cached !== undefined) {
      return cached;
    }
    const parsed = await getFileDiff(
      comparison.repoRoot,
      comparison.mergeBase,
      file
    );
    if (!this.isEditorTargetCurrent(editor, comparison, generation, file)) {
      return undefined;
    }
    comparison.parsedRanges.set(file.path, parsed);
    return parsed;
  }

  private async refreshSavedFile(document: vscode.TextDocument): Promise<void> {
    const comparison = this.comparison;
    if (comparison === undefined || document.uri.scheme !== "file") {
      return;
    }

    const relativePath = this.relativeRepositoryPath(
      comparison,
      document.uri.fsPath
    );
    if (relativePath === undefined) {
      return;
    }

    const existingFile = comparison.changedFiles.find(
      (file) => file.path === relativePath
    );
    if (existingFile === undefined) {
      return;
    }

    const generation = this.invalidateAsyncOperations(comparison);
    try {
      comparison.parsedRanges.delete(relativePath);
      const editors = vscode.window.visibleTextEditors.filter(
        (candidate) => candidate.document.uri.toString() === document.uri.toString()
      );
      await Promise.all(
        editors.map((editor) =>
          this.applyDecorations(editor, comparison, generation)
        )
      );
    } catch (error) {
      if (this.isComparisonCurrent(comparison, generation)) {
        this.showError(`Unable to refresh ${relativePath}`, error);
      }
    }
  }

  private relativeRepositoryPath(
    comparison: ActiveComparison,
    filePath: string
  ): string | undefined {
    const relativePath = path.relative(
      comparison.repoRoot,
      path.resolve(filePath)
    );
    if (
      relativePath === "" ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      return undefined;
    }
    return relativePath.split(path.sep).join("/");
  }

  private invalidateAsyncOperations(
    comparison?: ActiveComparison
  ): number {
    const generation = ++this.generation;
    if (comparison !== undefined) {
      comparison.generation = generation;
    }
    return generation;
  }

  private isGenerationCurrent(generation: number): boolean {
    return this.generation === generation;
  }

  private isComparisonCurrent(
    comparison: ActiveComparison,
    generation: number
  ): boolean {
    return (
      this.comparison === comparison &&
      comparison.generation === generation &&
      this.isGenerationCurrent(generation)
    );
  }

  private isFileCurrent(
    comparison: ActiveComparison,
    generation: number,
    file: ChangedFile
  ): boolean {
    return (
      this.isComparisonCurrent(comparison, generation) &&
      comparison.changedFiles.includes(file)
    );
  }

  private isEditorTargetCurrent(
    editor: vscode.TextEditor,
    comparison: ActiveComparison,
    generation: number,
    file: ChangedFile
  ): boolean {
    return (
      this.isFileCurrent(comparison, generation, file) &&
      vscode.window.visibleTextEditors.includes(editor) &&
      editor.document.uri.scheme === "file" &&
      this.relativeRepositoryPath(
        comparison,
        editor.document.uri.fsPath
      ) === file.path
    );
  }

  private isDecorationCurrent(
    editor: vscode.TextEditor,
    comparison: ActiveComparison,
    generation: number,
    file: ChangedFile
  ): boolean {
    return (
      comparison.highlightsVisible &&
      this.isEditorTargetCurrent(editor, comparison, generation, file)
    );
  }

  private firstChangedLine(parsed: ParsedFileDiff): number | undefined {
    if (parsed.wholeFileAdded) {
      return 0;
    }
    const candidates = [
      ...parsed.added.map((range) => range.start),
      ...parsed.modified.map((range) => range.start),
      ...parsed.deletedMarkers
    ];
    return candidates.length === 0 ? undefined : Math.min(...candidates);
  }

  private clearDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.clearEditorDecorations(editor);
    }
  }

  private clearEditorDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(this.addedDecoration, []);
    editor.setDecorations(this.modifiedDecoration, []);
    editor.setDecorations(this.deletedDecoration, []);
  }

  private updateStatusBar(): void {
    const comparison = this.comparison;
    if (comparison === undefined) {
      this.statusBar.hide();
      return;
    }

    const hiddenSuffix = comparison.highlightsVisible ? "" : " (hidden)";
    this.statusBar.text = `$(git-compare) working vs ${comparison.baseBranch}${hiddenSuffix}`;
    this.statusBar.show();
  }

  private lastBaseStateKey(repoRoot: string): string {
    return `branchDiff.lastBase:${repoRoot}`;
  }

  private showError(context: string, error: unknown): void {
    const detail =
      error instanceof GitError
        ? error.stderr || error.message
        : error instanceof Error
          ? error.message
          : String(error);
    void vscode.window.showErrorMessage(`Branch Diff: ${context}. ${detail}`);
  }
}
