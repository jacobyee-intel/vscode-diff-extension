import type { DeletedBlock } from "./types";

export interface InsetStyle {
  fontSize: number;
  tabSize: number;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderDeletedBlockHtml(
  block: DeletedBlock,
  style: InsetStyle
): string {
  const start = block.originalStartLine;
  const end = start + block.lines.length - 1;
  const label =
    start === end
      ? `Deleted original line ${start}`
      : `Deleted original lines ${start} through ${end}`;
  const rows = block.lines
    .map(
      (line) =>
        `<div class="row"><span class="marker" aria-hidden="true">-</span><span class="text">${escapeHtml(line)}</span></div>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:var(--vscode-diffEditor-removedLineBackground,var(--vscode-editor-background));color:var(--vscode-diffEditor-removedTextForeground,var(--vscode-editor-foreground));}
body{font-family:var(--vscode-editor-font-family);font-size:${style.fontSize}px;user-select:text;}
.deleted{height:100%;display:flex;flex-direction:column;}
.row{box-sizing:border-box;display:flex;align-items:center;min-height:0;flex:1 1 0;white-space:pre;}
.marker{box-sizing:border-box;flex:0 0 2.5em;padding-left:.75em;color:var(--vscode-branchDiff-deletedLineForeground,var(--vscode-gitDecoration-deletedResourceForeground,var(--vscode-errorForeground)));}
.text{min-width:0;white-space:pre;tab-size:${style.tabSize};-moz-tab-size:${style.tabSize};}
</style>
</head>
<body><div class="deleted" role="region" aria-label="${escapeHtml(label)}">${rows}</div></body>
</html>`;
}
