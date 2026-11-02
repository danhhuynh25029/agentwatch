// Renders the four panels from the fictional demo transcripts into standalone HTML files.
// Usage: node tools/demo/render.js <compiled out/ dir> <demo projects dir> <dest dir> [light]
'use strict';
const path = require('path');
const fs = require('fs');
const [outDir, root, dest, theme] = process.argv.slice(2);
const out = path.resolve(outDir);
const { listProjects } = require(out + '/parser/store');
const { parseSession } = require(out + '/parser/parser');
const { readConversation } = require(out + '/parser/conversation');
const { buildDashboard, compareSessions, dayNDaysAgo } = require(out + '/parser/aggregate');
const { computeBlocks, mergeHours } = require(out + '/parser/blocks');
const { Pricing } = require(out + '/parser/pricing');
const { renderSession } = require(out + '/webview/render');
const { renderConversation, renderDashboard, renderCompare } = require(out + '/webview/views');

// The VS Code theme variables a webview receives (Dark Modern / Light Modern).
const DARK = { fg: '#cccccc', muted: '#9d9d9d', bg: '#1f1f1f' };
const LIGHT = { fg: '#3b3b3b', muted: '#6f6f6f', bg: '#ffffff' };
const t = theme === 'light' ? LIGHT : DARK;
const THEME = `:root{--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,monospace;--vscode-foreground:${t.fg};--vscode-descriptionForeground:${t.muted};--vscode-editor-background:${t.bg};--vscode-charts-orange:#d18616;--vscode-charts-green:#89d185;--vscode-errorForeground:#f85149;--vscode-editorWarning-foreground:#cca700;--vscode-focusBorder:#0078d4}`;
// Screenshots are static: drop the script so saved scroll state cannot interfere.
const fix = (html) => html.replace(/<style nonce="([^"]+)">/, (m) => m + THEME).replace(/<script nonce[\s\S]*?<\/script>/, '');

(async () => {
  fs.mkdirSync(dest, { recursive: true });
  const pricing = new Pricing();
  const sums = [];
  for (const p of await listProjects(root)) {
    for (const s of p.sessions) {
      const summary = await parseSession(s.filePath);
      sums.push({ summary, project: path.basename(summary.main.cwd || p.decodedPath) });
    }
  }
  const by = (prefix) => sums.find((x) => x.summary.title.startsWith(prefix)).summary;
  const main = by('Add multi-currency');
  fs.writeFileSync(path.join(dest, 'session.html'), fix(renderSession(main, 'N', 'c', { pricing, annotation: { tags: ['billing'] } }).html));
  fs.writeFileSync(path.join(dest, 'conversation.html'), fix(renderConversation(main.title, await readConversation(main.filePath), 'N', 'c')));
  const d = buildDashboard(sums, pricing, dayNDaysAgo(29));
  const blocks = computeBlocks(mergeHours(sums.map((x) => x.summary.totalByHour)), pricing);
  fs.writeFileSync(path.join(dest, 'dashboard.html'), fix(renderDashboard(d, 'All projects', 'N', 'c', { blocks, unusedMcp: [{ name: 'jira', scope: 'user' }], mcpChecked: true }).html));
  const other = by('Speed up');
  fs.writeFileSync(path.join(dest, 'compare.html'), fix(renderCompare(other, main, compareSessions(other, main, pricing), 'N', 'c')));
  console.log(`rendered ${sums.length} sessions, ${pricing.costByModel(main.totalByModel).toFixed(2)} USD featured`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
