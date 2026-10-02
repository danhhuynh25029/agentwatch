// Pure HTML rendering for the session panel (no vscode dependency, unit-testable).
// Everything coming from transcripts is untrusted and must go through esc().
import { formatDuration, formatTokens, totalTokens } from '../parser/format';
import { SessionSummary, SubagentNode, TokenUsage, ToolStat } from '../parser/types';

export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function n(v: number): string {
  return esc(v.toLocaleString('en-US'));
}

function tok(v: number): string {
  return `<span title="${n(v)}">${esc(formatTokens(v))}</span>`;
}

function time(iso: string | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? esc(iso) : esc(d.toLocaleString());
}

function cards(label: string, u: TokenUsage): string {
  const items: Array<[string, number]> = [
    ['Input', u.input],
    ['Output', u.output],
    ['Cache write', u.cacheWrite],
    ['Cache read', u.cacheRead],
    ['Total', totalTokens(u)],
  ];
  return `<div class="cards-row"><div class="cards-label">${esc(label)}</div><div class="cards">${items
    .map(([k, v]) => `<div class="card"><div class="card-k">${esc(k)}</div><div class="card-v">${tok(v)}</div></div>`)
    .join('')}</div></div>`;
}

function table(headers: string[], rows: string[], numericFrom = 1): string {
  if (rows.length === 0) return '<p class="muted">None</p>';
  const th = headers.map((h, i) => `<th class="${i >= numericFrom ? 'num' : ''}">${esc(h)}</th>`).join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function flattenAgents(list: SubagentNode[], out: SubagentNode[] = []): SubagentNode[] {
  for (const a of list) {
    out.push(a);
    flattenAgents(a.children, out);
  }
  return out;
}

export interface RenderResult {
  html: string;
  /** Transcript paths addressable from the webview by index (index 0 = main transcript). */
  transcripts: string[];
}

export function renderSession(s: SessionSummary, nonce: string, cspSource: string): RenderResult {
  const m = s.main;
  const transcripts = [s.filePath];

  const header = `
    <h1>${esc(s.title)}</h1>
    <div class="actions">
      <button data-action="refresh">Refresh</button>
      <button data-action="transcript" data-index="0">Open transcript</button>
    </div>
    <table class="kv">
      <tr><th>Project</th><td>${esc(m.cwd ?? '-')}</td></tr>
      <tr><th>Branch</th><td>${esc(m.gitBranch ?? '-')}</td></tr>
      <tr><th>Model(s)</th><td>${esc(s.models.join(', ') || '-')}</td></tr>
      <tr><th>Start</th><td>${time(m.startTime)}</td></tr>
      <tr><th>End</th><td>${time(m.endTime)}</td></tr>
      <tr><th>Duration</th><td>${esc(formatDuration(s.durationMs))}</td></tr>
      <tr><th>CLI version</th><td>${esc(m.version ?? '-')}</td></tr>
      <tr><th>Entrypoint</th><td>${esc(m.entrypoint ?? '-')}</td></tr>
      <tr><th>Session</th><td>${esc(s.sessionId)}</td></tr>
      <tr><th>Lines</th><td>${n(m.lines)}${m.badLines ? ` <span class="muted">(${n(m.badLines)} unparseable, skipped)</span>` : ''}</td></tr>
    </table>`;

  const tokens = `
    <h2>Tokens</h2>
    ${cards('Session incl. subagents', s.totalUsage)}
    ${cards('Main thread only', m.usage)}`;

  const modelRows = Object.entries(s.totalByModel)
    .sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]))
    .map(
      ([model, u]) =>
        `<tr><td>${esc(model)}</td><td class="num">${n(u.messages)}</td><td class="num">${tok(u.input)}</td><td class="num">${tok(u.output)}</td><td class="num">${tok(u.cacheWrite)}</td><td class="num">${tok(u.cacheRead)}</td><td class="num">${tok(totalTokens(u))}</td></tr>`,
    );
  const models = `<h2>Per model (incl. subagents)</h2>${table(
    ['Model', 'API msgs', 'Input', 'Output', 'Cache write', 'Cache read', 'Total'],
    modelRows,
  )}`;

  const agentRows = flattenAgents(s.subagents).map((a) => {
    let open = '';
    if (a.transcriptPath) {
      transcripts.push(a.transcriptPath);
      open = `<button class="link" data-action="transcript" data-index="${transcripts.length - 1}" title="Open transcript">open</button>`;
    }
    const own = a.transcriptPath ? tok(totalTokens(a.stats.usage)) : a.reportedTokens !== undefined ? `~${tok(a.reportedTokens)}` : '-';
    const nested = a.children.length ? tok(totalTokens(a.totalUsage)) : '';
    const calls = a.transcriptPath ? n(a.stats.toolCalls) : a.spawn?.result?.totalToolUseCount !== undefined ? n(a.spawn.result.totalToolUseCount) : '-';
    // Inline style attributes are blocked by the CSP, so indentation uses classes.
    const depthClass = 'd' + Math.min(a.depth, MAX_INDENT);
    return `<tr>
      <td><span class="${depthClass}">${a.depth > 1 ? '&#8627; ' : ''}${esc(a.agentType)}</span></td>
      <td>${esc(a.description)}</td>
      <td>${esc(a.model ?? '-')}</td>
      <td class="num">${own}</td>
      <td class="num">${nested}</td>
      <td class="num">${calls}</td>
      <td class="num">${esc(formatDuration(a.durationMs))}</td>
      <td class="${a.status === 'error' || a.status === 'failed' ? 'err' : ''}">${esc(a.status ?? '-')}</td>
      <td>${open}</td>
    </tr>`;
  });
  const agents = `<h2>Subagents (${n(s.agentCount)})</h2>${table(
    ['Type', 'Description', 'Model', 'Tokens', 'Incl. nested', 'Tool calls', 'Duration', 'Status', ''],
    agentRows,
    3,
  )}`;

  const mcpRows: string[] = [];
  for (const srv of Object.values(s.totalMcp).sort((a, b) => b.calls - a.calls)) {
    for (const t of sortTools(srv.tools)) {
      mcpRows.push(
        `<tr><td>${esc(srv.server)}</td><td>${esc(t.name)}</td><td class="num">${n(t.calls)}</td><td class="num ${t.errors ? 'err' : ''}">${n(t.errors)}</td></tr>`,
      );
    }
  }
  const mcp = `<h2>MCP tools (incl. subagents)</h2>${table(['Server', 'Tool', 'Calls', 'Errors'], mcpRows, 2)}`;

  const toolRows = sortTools(s.totalTools).map(
    (t) =>
      `<tr><td>${esc(t.name)}</td><td class="num">${n(t.calls)}</td><td class="num">${n(m.tools[t.name]?.calls ?? 0)}</td><td class="num ${t.errors ? 'err' : ''}">${n(t.errors)}</td></tr>`,
  );
  const tools = `<h2>Tools (incl. subagents)</h2>${table(['Tool', 'Calls', 'Main only', 'Errors'], toolRows)}`;

  const skillRows = Object.entries(s.totalSkills)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${n(v)}</td></tr>`);
  const skills = skillRows.length ? `<h2>Skills</h2>${table(['Skill', 'Calls'], skillRows)}` : '';

  const promptItems = m.prompts.map(
    (p) => `<li><span class="ts">${time(p.timestamp)}</span><span class="pt">${esc(p.text)}</span></li>`,
  );
  const prompts = `<h2>User prompts (${n(m.prompts.length)})</h2>${
    promptItems.length ? `<ol class="timeline">${promptItems.join('')}</ol>` : '<p class="muted">None</p>'
  }`;

  const csp = `default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${cspSource};`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(s.title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
${header}
${tokens}
${models}
${agents}
${mcp}
${tools}
${skills}
${prompts}
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
  return { html, transcripts };
}

function sortTools(tools: Record<string, ToolStat>): ToolStat[] {
  return Object.values(tools).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

export function renderMessage(message: string, nonce: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">${STYLE}</style></head><body><p class="muted">${esc(message)}</p></body></html>`;
}

const MAX_INDENT = 8;
const INDENT_CSS = Array.from({ length: MAX_INDENT }, (_, i) => `.d${i + 1} { padding-left: ${i * 16}px; }`).join('\n');

const STYLE = INDENT_CSS + `
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0 20px 40px; }
h1 { font-size: 1.5em; margin: 16px 0 8px; }
h2 { font-size: 1.15em; margin: 24px 0 8px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
thead th { color: var(--vscode-descriptionForeground); font-weight: 600; }
tbody tr:hover { background: var(--vscode-list-hoverBackground); }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
table.kv { width: auto; }
table.kv th { color: var(--vscode-descriptionForeground); font-weight: normal; padding-right: 24px; }
.muted { color: var(--vscode-descriptionForeground); }
.err { color: var(--vscode-errorForeground); }
.cards-row { margin: 8px 0; }
.cards-label { color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
.cards { display: flex; flex-wrap: wrap; gap: 8px; }
.card { background: var(--vscode-sideBar-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 12px; min-width: 110px; }
.card-k { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
.card-v { font-size: 1.4em; font-weight: 600; }
.actions { margin: 8px 0 12px; display: flex; gap: 8px; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; border-radius: 2px; cursor: pointer; font-family: inherit; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.link { background: none; color: var(--vscode-textLink-foreground); padding: 0; }
button.link:hover { text-decoration: underline; background: none; }
ol.timeline { list-style: none; padding: 0; margin: 0; }
ol.timeline li { display: flex; gap: 12px; padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border); }
ol.timeline .ts { color: var(--vscode-descriptionForeground); white-space: nowrap; min-width: 170px; }
ol.timeline .pt { white-space: pre-wrap; word-break: break-word; }
`;

// Only sends an action + numeric index; the extension resolves the index to a known path.
const SCRIPT = `
(function () {
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', function (e) {
    const el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (!el) return;
    const action = el.getAttribute('data-action');
    if (action === 'refresh') vscode.postMessage({ command: 'refresh' });
    if (action === 'transcript') vscode.postMessage({ command: 'openTranscript', index: Number(el.getAttribute('data-index')) });
  });
})();
`;
