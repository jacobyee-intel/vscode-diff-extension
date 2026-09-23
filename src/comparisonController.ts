import path from "node:path";
import * as vscode from "vscode";
import { createComparisonReplacement } from "./comparisonTransition";
import { buildDiffModel } from "./diffModel";
import {
  findRepositoryRoot,
  getBaseFileContent,
  getChangedFiles,
  getCurrentBranch,
  getLocalBranches,
  getMergeBase,
  GitError,
  localBranchExists,
  resolveRepositoryPath
} from "./git";
import { InsetManager, PROPOSED_API_INSTRUCTIONS } from "./insetManager";
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

const EDIT_DEBOUNCE_MS = 200;

export class ComparisonController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly addedDecoration: vscode.TextEditorDecorationType;
  private readonly modifiedDecoration: vscode.TextEditorDecorationType;
  private readonly addedGutterDecoration: vscode.TextEditorDecorationType;
  private readonly modifiedGutterDecoration: vscode.TextEditorDecorationType;
  private readonly deletedIndicatorDecoration: vscode.TextEditorDecorationType;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly insets = new InsetManager();
  private readonly editTimers = new Map<string, NodeJS.Timeout>();
  private comparison: ActiveComparison | undefined;
  private generation = 0;
  private proposedApiErrorGeneration = -1;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.addedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("branchDiff.addedLineBackground"),
      overviewRulerColor: new vscode.ThemeColor(
        "editorOverviewRuler.addedForeground"
      ),
      overviewRulerLane: vscode.OverviewRulerLane.Left
    });
    this.modifiedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor(
        "branchDiff.modifiedLineBackground"
      ),
      overviewRulerColor: new vscode.ThemeColor(
        "editorOverviewRuler.modifiedForeground"
      ),
      overviewRulerLane: vscode.OverviewRulerLane.Left
    });
    this.addedGutterDecoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.file(
        this.context.asAbsolutePath("media/diff-added.svg")
      ),
      gutterIconSize: "contain"
    });
    this.modifiedGutterDecoration =
      vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.file(
          this.context.asAbsolutePath("media/diff-modified.svg")
        ),
        gutterIconSize: "contain"
      });
    this.deletedIndicatorDecoration =
      vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.file(
          this.context.asAbsolutePath("media/diff-deleted.svg")
        ),
        gutterIconSize: "contain",
        overviewRulerColor: new vscode.ThemeColor(
          "editorOverviewRuler.deletedForeground"
        ),
        overviewRulerLane: vscode.OverviewRulerLane.Left
      });
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBar.command = "branchDiff.browseChangedFiles";

    this.disposables.push(
      this.addedDecoration,
      this.modifiedDecoration,
      this.addedGutterDecoration,
      this.modifiedGutterDecoration,
      this.deletedIndicatorDecoration,
      this.statusBar,
      this.insets,
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        this.insets.retainEditors(editors);
        for (const editor of editors) {
          this.renderEditorInBackground(editor);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.scheduleDocumentRender(event.document);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.cancelDocumentTimer(document);
        this.insets.clearDocument(document);
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
    const generation = this.beginReplacement();
    let installedComparison: ActiveComparison | undefined;
    try {
      const repoRoot = await this.chooseRepository();
      if (repoRoot === undefined || !this.isGenerationCurrent(generation)) {
        return;
      }
      const currentBranch = await getCurrentBranch(repoRoot);
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
      const preferred = selectPreferredBase(
        branches,
        this.context.workspaceState.get<string>(stateKey)
      );
      const baseBranch = await this.chooseBaseBranch(branches, preferred);
      if (baseBranch === undefined || !this.isGenerationCurrent(generation)) {
        return;
      }
      const mergeBase = await getMergeBase(repoRoot, baseBranch);
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
        baseContents: new Map(),
        highlightsVisible: true,
        expandedDeletionsVisible: true
      };
      this.comparison = comparison;
      installedComparison = comparison;
      await this.context.workspaceState.update(stateKey, baseBranch);
      if (!this.isComparisonCurrent(comparison, generation)) {
        return;
      }
      await this.renderVisibleEditors(comparison, generation);
      if (this.isComparisonCurrent(comparison, generation)) {
        this.updateStatusBar();
        await this.browseChangedFiles();
      }
    } catch (error) {
      if (
        this.isGenerationCurrent(generation) ||
        (installedComparison !== undefined &&
          this.comparison === installedComparison)
      ) {
        this.clearComparison();
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
    const selected = await this.chooseChangedFile(comparison.changedFiles);
    if (
      selected !== undefined &&
      this.isFileCurrent(comparison, comparison.generation, selected)
    ) {
      await this.openChangedFile(selected);
    }
  }

  public async toggleHighlights(): Promise<void> {
    const comparison = this.requireComparison();
    if (comparison === undefined) {
      return;
    }
    const generation = this.invalidate(comparison);
    comparison.highlightsVisible = !comparison.highlightsVisible;
    if (!comparison.highlightsVisible) {
      this.clearDecorations();
    } else {
      try {
        await this.renderVisibleEditors(comparison, generation);
      } catch (error) {
        if (this.isComparisonCurrent(comparison, generation)) {
          this.clearComparison();
          this.showError("Unable to enable comparison highlights", error);
        }
        return;
      }
    }
    if (this.isComparisonCurrent(comparison, generation)) {
      this.updateStatusBar();
    }
  }

  public async toggleExpandedDeletions(): Promise<void> {
    const comparison = this.requireComparison();
    if (comparison === undefined) {
      return;
    }
    const generation = this.invalidate(comparison);
    comparison.expandedDeletionsVisible =
      !comparison.expandedDeletionsVisible;
    if (!comparison.expandedDeletionsVisible) {
      this.insets.clearAll();
    } else {
      try {
        await this.renderVisibleEditors(comparison, generation);
      } catch (error) {
        if (this.isComparisonCurrent(comparison, generation)) {
          this.clearComparison();
          this.showError("Unable to enable expanded deleted rows", error);
        }
        return;
      }
    }
    if (this.isComparisonCurrent(comparison, generation)) {
      this.updateStatusBar();
    }
  }

  public async refreshComparison(): Promise<void> {
    const previous = this.requireComparison();
    if (previous === undefined) {
      return;
    }
    const previousGeneration = previous.generation;
    let replacement: ActiveComparison | undefined;
    try {
      if (
        !(await localBranchExists(
          previous.repoRoot,
          previous.baseBranch
        ))
      ) {
        throw new Error(
          `The base branch '${previous.baseBranch}' no longer exists locally.`
        );
      }
      const currentBranch = await getCurrentBranch(previous.repoRoot);
      const mergeBase = await getMergeBase(
        previous.repoRoot,
        previous.baseBranch
      );
      const changedFiles = await getChangedFiles(
        previous.repoRoot,
        mergeBase
      );
      if (!this.isComparisonCurrent(previous, previousGeneration)) {
        return;
      }
      const generation = ++this.generation;
      replacement = createComparisonReplacement(previous, generation, {
        currentBranch,
        mergeBase,
        changedFiles
      });
      this.cancelAllTimers();
      this.comparison = replacement;
      await this.renderVisibleEditors(replacement, generation);
      if (this.isComparisonCurrent(replacement, generation)) {
        this.updateStatusBar();
      }
    } catch (error) {
      if (replacement === undefined) {
        if (this.isComparisonCurrent(previous, previousGeneration)) {
          this.showError("Unable to refresh comparison", error);
        }
        return;
      }
      if (this.comparison === replacement) {
        const restored = await this.restoreComparison(previous);
        this.showError(
          restored
            ? "Unable to refresh comparison"
            : "Unable to refresh comparison; the previous presentation was cleared",
          error
        );
      }
    }
  }

  public clearComparison(): void {
    this.generation += 1;
    this.comparison = undefined;
    this.cancelAllTimers();
    this.clearDecorations();
    this.insets.clearAll();
    this.statusBar.hide();
  }

  private beginReplacement(): number {
    this.clearComparison();
    return this.generation;
  }

  private requireComparison(): ActiveComparison | undefined {
    if (this.comparison === undefined) {
      void vscode.window.showInformationMessage(
        "Branch Diff: Start a comparison first."
      );
    }
    return this.comparison;
  }

  private async renderVisibleEditors(
    comparison: ActiveComparison,
    generation: number
  ): Promise<void> {
    await Promise.all(
      vscode.window.visibleTextEditors.map((editor) =>
        this.renderEditor(editor, comparison, generation)
      )
    );
  }

  private async renderEditor(
    editor: vscode.TextEditor,
    expectedComparison?: ActiveComparison,
    expectedGeneration?: number
  ): Promise<void> {
    const comparison = expectedComparison ?? this.comparison;
    const generation = expectedGeneration ?? comparison?.generation;
    if (
      comparison === undefined ||
      generation === undefined ||
      !this.isComparisonCurrent(comparison, generation) ||
      editor.document.uri.scheme !== "file"
    ) {
      this.clearEditor(editor);
      return;
    }
    const relativePath = this.relativeRepositoryPath(
      comparison,
      editor.document.uri.fsPath
    );
    const file = comparison.changedFiles.find(
      (candidate) =>
        candidate.path === relativePath && candidate.status !== "D"
    );
    if (relativePath === undefined || file === undefined) {
      this.clearEditor(editor);
      return;
    }

    const version = editor.document.version;
    const baseContent = await this.getBaseContent(comparison, generation, file);
    if (
      baseContent === undefined ||
      !this.isRenderCurrent(editor, comparison, generation, file, version)
    ) {
      return;
    }
    const parsed = buildDiffModel(
      file.oldPath ?? file.path,
      file.path,
      baseContent,
      editor.document.getText()
    );
    if (!this.isRenderCurrent(editor, comparison, generation, file, version)) {
      return;
    }
    if (parsed.binary) {
      this.clearEditor(editor);
      return;
    }
    if (comparison.expandedDeletionsVisible) {
      this.insets.render(
        editor,
        parsed.deletedBlocks,
        this.insetStyle(editor),
        () =>
          this.isRenderCurrent(
            editor,
            comparison,
            generation,
            file,
            version
          ) && comparison.expandedDeletionsVisible
      );
    } else {
      this.insets.clearEditor(editor);
    }
    this.applyDecorations(editor, parsed, comparison.highlightsVisible);
  }

  private async getBaseContent(
    comparison: ActiveComparison,
    generation: number,
    file: ChangedFile
  ): Promise<string | undefined> {
    const cached = comparison.baseContents.get(file.path);
    if (cached !== undefined) {
      return cached;
    }
    const content = await getBaseFileContent(
      comparison.repoRoot,
      comparison.mergeBase,
      file
    );
    if (!this.isFileCurrent(comparison, generation, file)) {
      return undefined;
    }
    comparison.baseContents.set(file.path, content);
    return content;
  }

  private scheduleDocumentRender(document: vscode.TextDocument): void {
    const comparison = this.comparison;
    if (
      comparison === undefined ||
      document.uri.scheme !== "file" ||
      this.relativeRepositoryPath(comparison, document.uri.fsPath) === undefined
    ) {
      return;
    }
    this.insets.clearDocument(document);
    const key = document.uri.toString();
    const previous = this.editTimers.get(key);
    if (previous !== undefined) {
      clearTimeout(previous);
    }
    const generation = comparison.generation;
    this.editTimers.set(
      key,
      setTimeout(() => {
        this.editTimers.delete(key);
        if (!this.isComparisonCurrent(comparison, generation)) {
          return;
        }
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document === document) {
            this.renderEditorInBackground(editor, comparison, generation);
          }
        }
      }, EDIT_DEBOUNCE_MS)
    );
  }

  private cancelDocumentTimer(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const timer = this.editTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.editTimers.delete(key);
    }
  }

  private cancelAllTimers(): void {
    for (const timer of this.editTimers.values()) {
      clearTimeout(timer);
    }
    this.editTimers.clear();
  }

  private applyDecorations(
    editor: vscode.TextEditor,
    parsed: ParsedFileDiff,
    visible: boolean
  ): void {
    if (!visible) {
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
      this.addedGutterDecoration,
      parsed.wholeFileAdded
        ? this.allEditorLineMarkers(editor.document)
        : this.toEditorLineMarkers(parsed.added, editor.document)
    );
    editor.setDecorations(
      this.modifiedGutterDecoration,
      this.toEditorLineMarkers(parsed.modified, editor.document)
    );
    editor.setDecorations(
      this.deletedIndicatorDecoration,
      parsed.deletedBlocks.map((block) => {
        const line = Math.min(
          Math.max(0, block.afterLine),
          Math.max(0, editor.document.lineCount - 1)
        );
        return new vscode.Range(line, 0, line, 0);
      })
    );
  }

  private insetStyle(editor: vscode.TextEditor): {
    fontSize: number;
    tabSize: number;
  } {
    const configuration = vscode.workspace.getConfiguration(
      "editor",
      editor.document.uri
    );
    const configuredTabSize = editor.options.tabSize;
    return {
      fontSize: configuration.get<number>("fontSize", 14),
      tabSize:
        typeof configuredTabSize === "number" ? configuredTabSize : 4
    };
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

  private toEditorLineMarkers(
    ranges: readonly LineRange[],
    document: vscode.TextDocument
  ): vscode.Range[] {
    const lastLine = Math.max(0, document.lineCount - 1);
    const markers: vscode.Range[] = [];
    for (const range of ranges) {
      const start = Math.min(Math.max(0, range.start), lastLine);
      const end = Math.min(Math.max(start, range.end - 1), lastLine);
      for (let line = start; line <= end; line += 1) {
        markers.push(new vscode.Range(line, 0, line, 0));
      }
    }
    return markers;
  }

  private allEditorLineMarkers(document: vscode.TextDocument): vscode.Range[] {
    return this.toEditorLineMarkers(
      [{ start: 0, end: document.lineCount }],
      document
    );
  }

  private async openChangedFile(file: ChangedFile): Promise<void> {
    const comparison = this.comparison;
    if (comparison === undefined) {
      return;
    }
    const generation = comparison.generation;
    try {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(resolveRepositoryPath(comparison.repoRoot, file.path))
      );
      if (!this.isFileCurrent(comparison, generation, file)) {
        return;
      }
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn:
          vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active,
        preserveFocus: false,
        preview: false
      });
      await this.renderEditor(editor, comparison, generation);
      if (!this.isFileCurrent(comparison, generation, file)) {
        return;
      }
      const base = await this.getBaseContent(comparison, generation, file);
      if (base === undefined) {
        return;
      }
      const parsed = buildDiffModel(
        file.oldPath ?? file.path,
        file.path,
        base,
        document.getText()
      );
      const firstLine = this.firstChangedLine(parsed);
      if (firstLine !== undefined) {
        const line = Math.min(firstLine, Math.max(0, document.lineCount - 1));
        const position = new vscode.Position(line, 0);
        editor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport
        );
        editor.selection = new vscode.Selection(position, position);
      }
    } catch (error) {
      if (this.isFileCurrent(comparison, generation, file)) {
        this.clearComparison();
        this.showError(`Unable to open ${file.path}`, error);
      }
    }
  }

  private firstChangedLine(parsed: ParsedFileDiff): number | undefined {
    const candidates = [
      ...parsed.added.map((range) => range.start),
      ...parsed.modified.map((range) => range.start),
      ...parsed.deletedBlocks.map((block) => block.afterLine + 1)
    ];
    return candidates.length === 0 ? undefined : Math.min(...candidates);
  }

  private async chooseRepository(): Promise<string | undefined> {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri?.scheme === "file") {
      const activeRoot = await findRepositoryRoot(path.dirname(activeUri.fsPath));
      if (activeRoot !== undefined) {
        return activeRoot;
      }
    }
    const roots = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme === "file") {
        const root = await findRepositoryRoot(folder.uri.fsPath);
        if (root !== undefined) {
          roots.add(root);
        }
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
    const selected = await vscode.window.showQuickPick(
      [...roots]
        .sort((left, right) => left.localeCompare(right))
        .map((repoRoot) => ({
          label: path.basename(repoRoot),
          description: repoRoot,
          repoRoot
        })),
      { placeHolder: "Choose a Git repository", matchOnDescription: true }
    );
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
      const accept = quickPick.onDidAccept(() => {
        const item = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
        if (item !== undefined) {
          completed = true;
          quickPick.hide();
          resolve(item.branch);
        }
      });
      const hide = quickPick.onDidHide(() => {
        accept.dispose();
        hide.dispose();
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
      quickPick.items = files.map((file) => ({
        label:
          file.oldPath === undefined
            ? file.path
            : `${file.oldPath} -> ${file.path}`,
        description:
          file.status === "D"
            ? "Deleted (not selectable)"
            : `${file.status} ${STATUS_DESCRIPTIONS[file.status] ?? "Changed"}`,
        detail: file.path,
        file
      }));
      let completed = false;
      const accept = quickPick.onDidAccept(() => {
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
      const hide = quickPick.onDidHide(() => {
        accept.dispose();
        hide.dispose();
        quickPick.dispose();
        if (!completed) {
          resolve(undefined);
        }
      });
      quickPick.show();
    });
  }

  private relativeRepositoryPath(
    comparison: ActiveComparison,
    filePath: string
  ): string | undefined {
    const relative = path.relative(comparison.repoRoot, path.resolve(filePath));
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return undefined;
    }
    return relative.split(path.sep).join("/");
  }

  private invalidate(comparison: ActiveComparison): number {
    const generation = ++this.generation;
    comparison.generation = generation;
    this.cancelAllTimers();
    return generation;
  }

  private async restoreComparison(
    previous: ActiveComparison
  ): Promise<boolean> {
    this.clearDecorations();
    this.insets.clearAll();
    const generation = ++this.generation;
    previous.generation = generation;
    this.comparison = previous;
    try {
      await this.renderVisibleEditors(previous, generation);
      if (!this.isComparisonCurrent(previous, generation)) {
        return false;
      }
      this.updateStatusBar();
      return true;
    } catch {
      if (this.comparison === previous) {
        this.clearComparison();
      }
      return false;
    }
  }

  private renderEditorInBackground(
    editor: vscode.TextEditor,
    comparison = this.comparison,
    generation = comparison?.generation
  ): void {
    void this.renderEditor(editor, comparison, generation).catch(
      (error: unknown) => {
        if (
          comparison === undefined ||
          generation === undefined ||
          !this.isComparisonCurrent(comparison, generation)
        ) {
          return;
        }
        this.clearComparison();
        if (this.proposedApiErrorGeneration === generation) {
          return;
        }
        this.proposedApiErrorGeneration = generation;
        this.showError(
          error instanceof Error && error.message === PROPOSED_API_INSTRUCTIONS
            ? "Unable to render expanded deleted rows"
            : "Unable to update comparison presentation",
          error
        );
      }
    );
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

  private isRenderCurrent(
    editor: vscode.TextEditor,
    comparison: ActiveComparison,
    generation: number,
    file: ChangedFile,
    version: number
  ): boolean {
    return (
      this.isFileCurrent(comparison, generation, file) &&
      editor.document.version === version &&
      vscode.window.visibleTextEditors.includes(editor) &&
      this.relativeRepositoryPath(comparison, editor.document.uri.fsPath) ===
        file.path
    );
  }

  private clearDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.clearEditorDecorations(editor);
    }
  }

  private clearEditor(editor: vscode.TextEditor): void {
    this.clearEditorDecorations(editor);
    this.insets.clearEditor(editor);
  }

  private clearEditorDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(this.addedDecoration, []);
    editor.setDecorations(this.modifiedDecoration, []);
    editor.setDecorations(this.addedGutterDecoration, []);
    editor.setDecorations(this.modifiedGutterDecoration, []);
    editor.setDecorations(this.deletedIndicatorDecoration, []);
  }

  private updateStatusBar(): void {
    const comparison = this.comparison;
    if (comparison === undefined) {
      this.statusBar.hide();
      return;
    }
    const states = [
      comparison.highlightsVisible ? "highlights on" : "highlights off",
      comparison.expandedDeletionsVisible
        ? "deleted rows on"
        : "deleted rows off"
    ];
    this.statusBar.text = `$(git-compare) working vs ${comparison.baseBranch}`;
    this.statusBar.tooltip = `Branch Diff: ${states.join(", ")}. Browse changed files.`;
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
