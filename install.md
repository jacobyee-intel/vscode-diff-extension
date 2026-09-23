# Install Branch Diff 0.2.1

Prerequisites: Git and VS Code Stable 1.74 or newer.

1. In VS Code, run **Extensions: Install from VSIX...** and select
   `branch-diff-0.2.1.vsix`.
2. Fully quit every VS Code window.
3. Relaunch with:

   ```bash
   code --enable-proposed-api=local.branch-diff
   ```

   Alternatively, run **Preferences: Configure Runtime Arguments**, add or
   merge the following in `argv.json`, then fully quit and restart VS Code:

   ```json
   {
     "enable-proposed-api": ["local.branch-diff"]
   }
   ```

Keybindings:

- `Ctrl+E Ctrl+T`: toggle expanded deleted rows
- `Ctrl+E Ctrl+G`: browse changed files
- `Ctrl+E Ctrl+R`: toggle highlights
