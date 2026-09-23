# Branch Diff

Branch Diff compares the currently checked-out branch and working tree against a selected local base branch, then highlights changes directly in normal editable VS Code editors. It never opens VS Code's side-by-side diff editor.

## Behavior

The extension finds the merge base between the selected base branch and `HEAD`, then compares that commit with the current working tree. The result includes:

- commits made on the current branch after it diverged from the base;
- staged and unstaged changes;
- untracked, non-ignored files, treated as entirely added.

Added lines use a green background. Modified lines use a theme-aware blue or yellow background. Deleted-only hunks attach a red marker to the nearest surviving line. Only files in the active comparison and inside its repository are decorated.

## Commands

| Command | ID | Keybinding |
| --- | --- | --- |
| Branch Diff: Choose Base Branch and Start | `branchDiff.startComparison` | Command Palette |
| Branch Diff: Browse Changed Files | `branchDiff.browseChangedFiles` | `Ctrl+E T` |
| Branch Diff: Toggle Highlights | `branchDiff.toggleHighlights` | `Ctrl+E R` |
| Branch Diff: Refresh Comparison | `branchDiff.refreshComparison` | Command Palette |
| Branch Diff: Clear Comparison | `branchDiff.clearComparison` | Command Palette |

Starting a comparison immediately opens a searchable changed-files picker. It shows each relative path and Git status. Renames appear as `old/path -> new/path` and open the new path. Deleted files remain visible but cannot be selected because there is no editable working-tree file to open.

The preferred base branch is the most recently selected base for that repository in the current workspace when it still exists. Otherwise the extension prefers `main`, `master`, then `develop`, followed by the first local branch alphabetically. The current branch is excluded.

The status bar item, for example `working vs develop`, reopens the changed-files picker.

## Refresh and editing

Working-tree content is authoritative, so hunk line numbers come from `git diff <merge-base> -- <path>`. Saving an open changed file refreshes its decorations. **Refresh Comparison** recomputes the current branch, merge base, changed-file list, and all visible relevant editors. **Toggle Highlights** hides or restores decorations without discarding the comparison, while **Clear Comparison** removes all comparison state.

## Repository handling and limitations

- The active editor's repository is preferred. In a multi-root workspace without an active repository file, the extension asks which detected repository to use.
- Detached `HEAD`, missing repositories, stale base branches, and repositories without another local branch are reported explicitly.
- Binary files can be listed and may be opened by VS Code, but line decorations are unavailable.
- Rename detection uses Git's normal similarity heuristic.
- The changed-files picker cannot visually disable individual VS Code quick-pick rows, so deleted rows are labeled `Deleted (not selectable)` and accepting one keeps the picker open with a validation message.
- The extension invokes the `git` executable directly with argument arrays. Git must be available on `PATH`.

## Development

Requirements: Node.js 20 or newer, npm, Git, and VS Code 1.74 or newer.

```bash
npm install
npm run compile
npm run lint
npm test
```

Press `F5` from VS Code to launch an Extension Development Host after compiling. The TypeScript output is written to `out/`; no bundler is required for this small extension.

## Package and install

Create an installable VSIX:

```bash
npx @vscode/vsce package --no-dependencies
```

The package is written to `branch-diff-<version>.vsix`. In VS Code, open the
Extensions view, select **Views and More Actions...**, choose
**Install from VSIX...**, and select the generated file.
