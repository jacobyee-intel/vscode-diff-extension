# Branch Diff

Branch Diff compares the checked-out branch and working tree against a selected
local base branch in normal, editable VS Code editors. Added and modified lines
are highlighted, and complete deleted blocks are expanded inline as selectable,
copyable rows. It does not open VS Code's native diff editor.

## Required VS Code Stable launch

Version 0.2.0 uses VS Code's proposed `editorInsets` API. A manually installed
VSIX must be enabled explicitly:

```bash
code --enable-proposed-api=local.branch-diff
```

**Fully quit every existing VS Code window before launching with the flag.**
An already-running VS Code process will otherwise reuse the old process without
enabling the proposal. If the API is unavailable, Branch Diff reports this
exact requirement and does not substitute markers, hovers, virtual documents,
or another deleted-content UI.

To enable the proposal persistently, open **Preferences: Configure Runtime
Arguments**, add the following to `argv.json`, then fully quit and restart VS
Code:

```json
{
  "enable-proposed-api": ["local.branch-diff"]
}
```

Keep any existing `argv.json` properties and add or merge the
`enable-proposed-api` property rather than replacing the file.

## Behavior

The extension finds the merge base between the selected base branch and
`HEAD`, then compares that commit with the current working tree. The result
includes branch commits, staged and unstaged changes, and untracked,
non-ignored files.

- Added lines use a green background.
- Modified lines use a theme-aware background.
- Every deleted block is rendered in one editor inset at its true position,
  including before the first line and at EOF.
- Replacements show the complete old block above the highlighted new block.
- Expanded deleted rows are enabled when a comparison starts.
- Comparison presentation is all-or-nothing. Insets are created before
  decorations are committed; any render failure clears the affected
  comparison, its status, decorations, and insets. Background render failures
  are reported once and cannot leave a partial presentation.
- Unsaved edits are diffed in memory against the cached merge-base content
  after a short debounce, so highlights and deleted rows remain accurate
  without saving.
- Split editor groups own independent inset sets.

## Commands

| Command | ID | Keybinding |
| --- | --- | --- |
| Branch Diff: Choose Base Branch and Start | `branchDiff.startComparison` | Command Palette |
| Branch Diff: Toggle Expanded Deleted Rows | `branchDiff.toggleExpandedDeletions` | `Ctrl+E Ctrl+T` |
| Branch Diff: Browse Changed Files | `branchDiff.browseChangedFiles` | `Ctrl+E Ctrl+G` |
| Branch Diff: Toggle Highlights | `branchDiff.toggleHighlights` | `Ctrl+E Ctrl+R` |
| Branch Diff: Refresh Comparison | `branchDiff.refreshComparison` | Command Palette |
| Branch Diff: Clear Comparison | `branchDiff.clearComparison` | Command Palette |

Starting a comparison opens a searchable changed-files picker. Renames appear
as `old/path -> new/path` and use the old merge-base path for comparison.
Deleted files remain listed but cannot be opened because no editable
working-tree file exists. The status bar reopens the picker.

The preferred base is the most recently selected base for that repository when
it still exists. Otherwise Branch Diff prefers `main`, `master`, then
`develop`, followed by the first local branch alphabetically. The current
branch is excluded.

**Refresh Comparison** builds a replacement branch, merge base, changed-file
list, and base-content cache independently, then commits and renders it as one
transition. A failed refresh restores the prior valid comparison when possible;
otherwise it clears the presentation rather than retaining stale state.
**Clear Comparison**, starting a new comparison, toggling deleted rows off,
closing or replacing an editor, extension disposal, and render errors dispose
the applicable inset ownership.

## Repository handling

- The active editor's repository is preferred. Multi-root workspaces prompt
  when needed.
- Git is invoked directly with argument arrays and stabilized diff options:
  explicit `a/` and `b/` prefixes, no color, no external diff, zero context,
  and rename detection. Git C-quoted section paths are decoded strictly,
  including tabs, newlines, quotes, backslashes, and octal byte escapes.
- Live unsaved-content diffs use the diff library's structured hunk model, so
  repository paths are never embedded in synthetic line-oriented headers.
- Parsing is strict, file-scoped, and count-driven. Malformed, truncated, or
  ambiguous output is rejected instead of guessed.
- Binary files may be listed, but line-level rendering is unavailable.
- Additions and untracked text files compare against empty merge-base content.

## Troubleshooting

- **Expanded rows require the proposed API:** fully quit all VS Code windows
  and relaunch with
  `code --enable-proposed-api=local.branch-diff`, or configure `argv.json`.
- **No rows after editing:** wait briefly for the approximately 200 ms live
  diff debounce. Refresh if the base branch or repository state changed.
- **Git error:** ensure `git` is available on `PATH`, the workspace is trusted,
  and the selected local base branch still exists.
- **Binary file:** binary content intentionally has no line-level rendering.

## Development

Requirements: Node.js 20 or newer, npm, Git, and VS Code 1.74 or newer. The
extension retains the existing VS Code 1.74 engine floor; the proposed
declaration is vendored separately.

```bash
npm install
npm run compile
npm run lint
npm test
npm run test:integration
```

The integration test uses `@vscode/test-electron`, locates an installed VS Code
from `VSCODE_EXECUTABLE_PATH`, `PATH`, or standard install locations, and
otherwise downloads VS Code 1.91.1. On Linux it starts Xvfb automatically when
`DISPLAY` is unset. It runs both proposed-API and no-flag Extension Development
Host smoke tests.

## Package and install

```bash
npm run package:vsix
npm run verify:vsix -- branch-diff-0.2.0.vsix
```

Use the ordinary `vsce package` flow above. Do not add `--no-dependencies`:
Branch Diff requires the production `diff` package at runtime. The verification
command asserts the exact packaged CommonJS runtime file set.

Install `branch-diff-0.2.0.vsix` using **Extensions: Install from VSIX...**,
then launch Stable with the required proposed-API flag above.
