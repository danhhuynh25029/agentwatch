// Pure HTML rendering for the session panel (no vscode dependency, unit-testable).
// Everything coming from transcripts is untrusted and must go through esc().
import { formatDuration, formatTokens, totalTokens } from '../parser/format';
import * as pathLib from 'path';
import { cacheHitRate, formatPercent, formatUsd, Pricing } from '../parser/pricing';
import { SessionSummary, SubagentNode, TokenUsage, ToolStat } from '../parser/types';
import { SessionAnnotation } from '../annotations';
import { approxTokens, sessionInsights, toolLabel } from '../parser/insights';
import { action, chip, esc, figures, ganttChart, GanttRow, hero, kpis, MAX_INDENT, n, nav, page, pill, scrubChart, section, shareBar, statusPill, table, time, tok, weighted } from './html';

export { esc, renderMessage } from './html';

function usageCards(label: string, u: TokenUsage, cost: number): string {
  return kpis(
    [
      { label: 'Input', value: tok(u.input), tone: 'blue' },
      { label: 'Output', value: tok(u.output), tone: 'purple' },
      { label: 'Cache write', value: tok(u.cacheWrite), sub: u.cacheWrite1h ? `${tok(u.cacheWrite1h)} at 1h TTL` : undefined, tone: 'orange' },
      { label: 'Cache read', value: tok(u.cacheRead), tone: 'teal' },
      { label: 'Total', value: tok(totalTokens(u)), tone: 'blue' },
      { label: 'Cost (est.)', value: esc(formatUsd(cost)), tone: 'green' },
    ],
    label,
  );
}

/** Pre-order flatten, iterative so deeply nested (crafted) agent chains cannot overflow the stack. */
export function flattenAgents(list: SubagentNode[]): SubagentNode[] {
  const out: SubagentNode[] = [];
  const stack = [...list].reverse();
  while (stack.length) {
    const a = stack.pop()!;
    out.push(a);
    for (let i = a.children.length - 1; i >= 0; i--) stack.push(a.children[i]);
  }
  return out;
}

export interface RenderResult {
  html: string;
  /** Transcript paths addressable from the webview by index (index 0 = main transcript). */
  transcripts: string[];
  /** Edited file paths addressable from the webview by index. */
  files: string[];
}

export interface RenderOptions {
  pricing: Pricing;
  annotation?: SessionAnnotation;
  /** True when the transcript was modified very recently (session probably running). */
  live?: boolean;
}

export function renderSession(s: SessionSummary, nonce: string, cspSource: string, opts: RenderOptions): RenderResult {
  const m = s.main;
  const { pricing } = opts;
  const ann = opts.annotation ?? {};
  const transcripts = [s.filePath];
  const files: string[] = [];
  const totalCost = pricing.costByModel(s.totalByModel);
  const unpriced = pricing.unpriced(s.totalByModel);

  const live = opts.live ? pill(m.pendingTools.length ? `live · ${m.pendingTools[m.pendingTools.length - 1]}` : 'live', 'live') : '';
  const isCodex = /^rollout-/.test(pathLib.basename(s.filePath));
  const metaChips = [
    chip(isCodex ? 'Codex' : 'Claude Code'),
    ann.pinned ? chip('pinned') : '',
    m.cwd ? chip(pathLib.basename(m.cwd), { title: m.cwd }) : '',
    m.gitBranch ? chip(m.gitBranch, { mono: true }) : '',
    ...s.models.map((model) => chip(model, { tone: 'purple' })),
    m.startTime ? chip(new Date(m.startTime).toLocaleString(), {}) : '',
    s.durationMs !== undefined ? chip(formatDuration(s.durationMs), {}) : '',
    m.version ? chip('v' + m.version, { mono: true }) : '',
    ...(ann.tags ?? []).map((t) => chip('#' + t, { tone: 'teal' })),
  ].join('');
  const hit = cacheHitRate(s.totalUsage);
  const errorCount = s.totalToolErrors.length;
  const fileCount = Object.keys(s.totalFileEdits).length;
  const keyFigures = figures(
    {
      label: 'Estimated cost',
      value: esc(formatUsd(totalCost)),
      sub: m.reportedCostUsd !== undefined ? `Claude Code recorded ${esc(formatUsd(m.reportedCostUsd))}` : 'at API list prices',
    },
    [
      { label: 'Tokens', value: tok(totalTokens(s.totalUsage)), sub: `main thread ${tok(totalTokens(m.usage))}` },
      { label: 'Cache hit', value: esc(formatPercent(hit)), sub: `${tok(s.totalUsage.cacheRead)} read from cache` },
      { label: 'Duration', value: esc(formatDuration(s.durationMs)), sub: `${n(m.apiMessages)} API messages` },
    ],
    [
      `<b>${tok(s.totalUsage.output)}</b> output`,
      `<b>${n(s.totalToolCalls)}</b> tool calls${errorCount ? `, <span class="err">${n(errorCount)} failed</span>` : ''}`,
      `<b>${n(s.agentCount)}</b> subagents`,
      `<b>${n(fileCount)}</b> files changed`,
      `<b>${n(m.commits.length)}</b> commits`,
    ],
  );
  const header = hero({
    title: s.title,
    meta: metaChips,
    extra: (live ? `<div class="chips">${live}</div>` : '') + (ann.note ? `<div class="note">${esc(ann.note)}</div>` : '') + keyFigures,
    actions: [
      action('conversation', 'Conversation', { variant: 'primary' }),
      action('resume', 'Resume', {}),
      action('export', 'Export', {}),
      action('compare', 'Compare', {}),
      action('openTranscript', 'Raw JSONL', { index: 0 }),
      action('pin', ann.pinned ? 'Unpin' : 'Pin', { variant: 'ghost' }),
      action('tags', 'Tags', { variant: 'ghost' }),
      action('note', 'Note', { variant: 'ghost' }),
      action('refresh', 'Refresh', { variant: 'ghost' }),
    ].join(''),
  });

  const details = section(
    'details',
    'Session details',
    `<table class="kv">
      <tr><th>Project</th><td>${esc(m.cwd ?? '-')}</td></tr>
      <tr><th>Branch</th><td>${esc(m.gitBranch ?? '-')}</td></tr>
      <tr><th>Model(s)</th><td>${esc(s.models.join(', ') || '-')}</td></tr>
      <tr><th>Start</th><td>${time(m.startTime)}</td></tr>
      <tr><th>End</th><td>${time(m.endTime)}</td></tr>
      <tr><th>Duration</th><td>${esc(formatDuration(s.durationMs))}</td></tr>
      <tr><th>CLI version</th><td>${esc(m.version ?? '-')}</td></tr>
      <tr><th>Entrypoint</th><td>${esc(m.entrypoint ?? '-')}</td></tr>
      <tr><th>Session</th><td><code>${esc(s.sessionId)}</code></td></tr>
      <tr><th>Lines</th><td>${n(m.lines)}${m.badLines ? ` <span class="muted">(${n(m.badLines)} unparseable, skipped)</span>` : ''}${m.skipped ? ` <span class="err">(${esc(m.skipped)})</span>` : ''}</td></tr>
    </table>`,
    { collapsible: true, open: false },
  );

  // Cost drivers: the main thread and every subagent with a transcript, ranked by its own cost.
  const mainCost = pricing.costByModel(m.usageByModel);
  const drivers = [
    { name: 'Main thread', detail: '', models: m.models, tokens: totalTokens(m.usage), cost: mainCost, depth: 1 },
    ...flattenAgents(s.subagents)
      .filter((a) => a.transcriptPath)
      .map((a) => ({ name: a.agentType, detail: a.description, models: a.stats.models, tokens: totalTokens(a.stats.usage), cost: pricing.costByModel(a.stats.usageByModel), depth: a.depth })),
  ].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  const DRIVER_ROWS = 8;
  const driverRows = drivers.slice(0, DRIVER_ROWS).map(
    (d) =>
      `<tr><td><span class="cell-strong">${esc(d.name)}</span>${d.detail ? `<div class="muted small">${esc(d.detail)}</div>` : ''}</td><td class="muted">${esc(d.models.join(', ') || '-')}</td><td class="num">${tok(
        d.tokens,
      )}</td><td class="num">${weighted(esc(formatUsd(d.cost)), totalCost ? d.cost / totalCost : 0)}</td><td>${shareBar(totalCost ? d.cost / totalCost : 0)}</td></tr>`,
  );
  const driversTable = `${table(['Thread', 'Model', 'Tokens', 'Cost', 'Share'], driverRows, 2)}${
    drivers.length > DRIVER_ROWS ? `<p class="explain">${n(drivers.length - DRIVER_ROWS)} more in <a class="btn-link" href="#agents">Subagents</a>.</p>` : ''
  }`;

  const tokensBody = `${usageCards('Session incl. subagents', s.totalUsage, totalCost)}
    ${usageCards('Main thread only', m.usage, pricing.costByModel(m.usageByModel))}
    <p class="explain">Estimated from public API list prices; cache writes are priced by their 5-minute or 1-hour TTL.${
      m.reportedCostUsd !== undefined ? ` Claude Code recorded ${esc(formatUsd(m.reportedCostUsd))} itself (may cover only the latest run after a resume).` : ''
    } Override prices with <code>agentwatch.pricing</code>.${unpriced.length ? ` No price for: ${esc(unpriced.join(', '))} (counted as $0).` : ''}</p>`;

  const peak = m.context.reduce((mx, p) => Math.max(mx, p.tokens), 0);
  const peakIndex = m.context.findIndex((p) => p.tokens === peak);
  const contextChartHtml = `
    ${scrubChart(
      m.context.map((p) => ({
        x: p.i,
        y: p.tokens,
        title: `#${p.i + 1} · ${formatTokens(p.tokens)} tokens${p.timestamp ? ' · ' + new Date(p.timestamp).toLocaleTimeString() : ''}`,
        value: formatTokens(p.tokens),
        meta: `${p.tokens === peak ? 'peak · ' : ''}message ${(p.i + 1).toLocaleString('en-US')} of ${m.apiMessages.toLocaleString('en-US')}${p.timestamp ? ' · ' + new Date(p.timestamp).toLocaleTimeString() : ''}`,
      })),
      m.compactions.map((c) => ({ x: c.i, y: 0, title: `Compaction${c.timestamp ? ' at ' + new Date(c.timestamp).toLocaleString() : ''}` })),
      formatTokens,
      peakIndex,
    )}
    <div class="axis-note"><span>${time(m.startTime)}</span><span>${m.compactions.length ? `${n(m.compactions.length)} compaction(s), dashed` : 'drag to scrub'}</span><span>${time(m.endTime)}</span></div>`;

  const insightItems = sessionInsights(s, pricing);
  const insights = insightItems.length
    ? `<div class="caption">Insights</div><div class="insights">${insightItems
        .map(
          (i) =>
            `<div class="insight ${i.severity}"><div class="ic"></div><div><div class="t">${esc(i.title)}</div><div class="d">${esc(i.detail)}</div></div></div>`,
        )
        .join('')}</div>`
    : '';

  const sizes = Object.values(s.totalResultSizes).sort((a, b) => b.chars - a.chars);
  const totalChars = sizes.reduce((x, r) => x + r.chars, 0) || 1;
  const sizeRows = sizes.slice(0, 20).map(
    (r) =>
      `<tr><td>${esc(toolLabel(r.name))}</td><td class="num">${n(r.calls)}</td><td class="num">~${tok(approxTokens(r.chars))}</td><td class="num">~${tok(approxTokens(r.chars / Math.max(r.calls, 1)))}</td><td>${shareBar(r.chars / totalChars)}</td></tr>`,
  );
  const bigRows = s.totalLargestResults.slice(0, 10).map(
    (r) =>
      `<tr><td class="ts">${time(r.timestamp)}</td><td>${esc(toolLabel(r.tool))}${r.agent ? `<div class="muted">${esc(r.agent)}</div>` : ''}</td><td><pre>${esc(r.input || '-')}</pre></td><td class="num">~${tok(approxTokens(r.chars))}</td></tr>`,
  );
  const readRows = Object.values(s.totalFileReads)
    .filter((r) => r.reads > 1)
    .sort((a, b) => b.reads - a.reads || b.chars - a.chars)
    .slice(0, 15)
    .map((r) => `<tr><td>${esc(r.path)}</td><td class="num">${n(r.reads)}</td><td class="num">~${tok(approxTokens(r.chars))}</td></tr>`);
  const contextSection = section(
    'context',
    'Context',
    `${contextChartHtml}
    <h3>What fills the context</h3>
    <p class="explain">Tool results by size (about 4 characters per token). They stay in the context until a compaction.</p>
    ${table(['Tool', 'Results', 'Total', 'Average', 'Share'], sizeRows)}
    ${bigRows.length ? `<h3>Largest results</h3>${table(['Time', 'Tool', 'Input', 'Size'], bigRows, 3)}` : ''}
    ${readRows.length ? `<h3>Files read more than once</h3>${table(['File', 'Reads', 'Total'], readRows)}` : ''}`,
    { subtitle: `peak ${formatTokens(peak)}` },
  );

  const timed = flattenAgents(s.subagents).filter((a) => a.stats.startTime && a.stats.endTime).slice(0, 200);
  let gantt = '';
  if (timed.length) {
    const t0 = Math.min(Date.parse(m.startTime ?? '') || Infinity, ...timed.map((a) => Date.parse(a.stats.startTime!)));
    const t1 = Math.max(Date.parse(m.endTime ?? '') || 0, ...timed.map((a) => Date.parse(a.stats.endTime!)));
    const rows: GanttRow[] = timed.map((a) => ({
      label: `${a.agentType} · ${a.description}`,
      start: Date.parse(a.stats.startTime!),
      end: Date.parse(a.stats.endTime!),
      error: a.status === 'error' || a.status === 'failed',
      depth: a.depth,
      title: `${a.agentType} · ${a.description}\n${formatDuration(Date.parse(a.stats.endTime!) - Date.parse(a.stats.startTime!))} · ${formatTokens(totalTokens(a.totalUsage))} tokens`,
    }));
    gantt = `<h3>Timeline</h3>${ganttChart(rows, t0, t1)}<div class="axis-note"><span>${time(new Date(t0).toISOString())}</span><span>${time(new Date(t1).toISOString())}</span></div>`;
  }

  let prevCost = 0;
  const commitRows = m.commits.map((c) => {
    const cost = pricing.costByModel(c.usageAtCommit);
    const delta = cost - prevCost;
    prevCost = cost;
    return `<tr><td class="ts">${time(c.timestamp)}</td><td>${c.hash ? `<code>${esc(c.hash)}</code>` : '-'}</td><td>${c.branch ? chip(c.branch, { mono: true }) : ''}</td><td>${
      c.failed
        ? `<span class="err">failed</span> <span class="muted">${esc(c.command)}</span>`
        : c.message
          ? esc(c.message)
          : `<span class="muted">(no commit output) ${esc(c.command)}</span>`
    }</td><td class="num">${weighted(esc(formatUsd(delta)), totalCost ? delta / totalCost : 0)}</td></tr>`;
  });
  const commits = commitRows.length
    ? section('commits', 'Commits', `${table(['Time', 'Hash', 'Branch', 'Message', 'Cost since previous'], commitRows, 4)}<p class="explain">Cost since previous counts the main thread only.</p>`, {
        count: commitRows.length,
      })
    : '';

  const modelRows = Object.entries(s.totalByModel)
    .filter(([, u]) => totalTokens(u) > 0)
    .sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]))
    .map(
      ([model, u]) =>
        `<tr><td>${chip(model, { tone: 'purple' })}</td><td class="num">${n(u.messages)}</td><td class="num">${tok(u.input)}</td><td class="num">${tok(u.output)}</td><td class="num">${tok(u.cacheWrite)}</td><td class="num">${tok(u.cacheRead)}</td><td class="num">${tok(totalTokens(u))}</td><td class="num">${esc(formatPercent(cacheHitRate(u)))}</td><td class="num">${weighted(esc(formatUsd(pricing.cost(model, u))), totalCost ? pricing.cost(model, u) / totalCost : 0)}</td></tr>`,
    );
  const models = `<h3>Per model (incl. subagents)</h3>${table(
    ['Model', 'API msgs', 'Input', 'Output', 'Cache write', 'Cache read', 'Total', 'Cache hit', 'Cost'],
    modelRows,
  )}`;

  const agentRows = flattenAgents(s.subagents).map((a) => {
    let open = '';
    if (a.transcriptPath) {
      transcripts.push(a.transcriptPath);
      open = action('openTranscript', 'open', { index: transcripts.length - 1, link: true, title: 'Open transcript' });
    }
    const own = a.transcriptPath ? tok(totalTokens(a.stats.usage)) : a.reportedTokens !== undefined ? `~${tok(a.reportedTokens)}` : '-';
    const nested = a.children.length ? tok(totalTokens(a.totalUsage)) : '';
    const calls = a.transcriptPath ? n(a.stats.toolCalls) : a.spawn?.result?.totalToolUseCount !== undefined ? n(a.spawn.result.totalToolUseCount) : '-';
    const ownCost = pricing.costByModel(a.stats.usageByModel);
    const cost = a.transcriptPath ? weighted(esc(formatUsd(ownCost)), totalCost ? ownCost / totalCost : 0) : '-';
    // Inline style attributes are blocked by the CSP, so indentation uses classes.
    const depthClass = 'd' + Math.min(a.depth, MAX_INDENT);
    return `<tr>
      <td><span class="${depthClass} cell-strong">${a.depth > 1 ? '&#8627; ' : ''}${esc(a.agentType)}</span></td>
      <td>${esc(a.description)}</td>
      <td>${a.model ? chip(a.model, { tone: 'purple' }) : '-'}</td>
      <td class="num">${own}</td>
      <td class="num">${nested}</td>
      <td class="num">${cost}</td>
      <td class="num">${calls}</td>
      <td class="num">${esc(formatDuration(a.durationMs))}</td>
      <td>${statusPill(a.status)}</td>
      <td>${open}</td>
    </tr>`;
  });
  const agentsSkipped =
    (s.subagentFilesSkipped
      ? `<p class="muted">${n(s.subagentFilesSkipped)} more subagent transcript(s) not parsed (per-session limit reached).</p>`
      : '') +
    (s.spawnNodesSkipped
      ? `<p class="muted">${n(s.spawnNodesSkipped)} more subagent spawn(s) without a transcript not shown (per-session limit reached).</p>`
      : '');
  const agents = s.agentCount
    ? section(
        'agents',
        'Subagents',
        `${agentsSkipped}${table(['Type', 'Description', 'Model', 'Tokens', 'Incl. nested', 'Cost', 'Tool calls', 'Duration', 'Status', ''], agentRows, 3)}${gantt}`,
        { count: s.agentCount },
      )
    : '';

  const fileRows = Object.values(s.totalFileEdits)
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => {
      files.push(f.path);
      const i = files.length - 1;
      return `<tr><td>${action('openFile', pathLib.basename(f.path), { index: i, link: true, title: f.path })}<div class="muted small">${esc(pathLib.dirname(f.path))}</div></td><td class="num">${n(f.edits)}</td><td class="num">${n(f.writes)}</td><td class="num ${f.failed ? 'err' : ''}">${n(f.failed)}</td><td>${action('fileEdits', 'Changes', { index: i, variant: 'ghost', title: 'Show the edits made in this session' })}</td></tr>`;
    });
  const filesSection = fileRows.length ? section('files', 'Files changed', table(['File', 'Edits', 'Writes', 'Failed', ''], fileRows), { count: fileRows.length }) : '';

  const errorRows = s.totalToolErrors.map(
    (e) =>
      `<tr><td class="ts">${time(e.timestamp)}</td><td class="cell-strong">${esc(toolLabel(e.tool))}${e.agent ? `<div class="muted">${esc(e.agent)}</div>` : ''}</td><td>${
        e.input ? `<pre>${esc(e.input)}</pre>` : ''
      }<pre class="err">${esc(e.error || '(no error text)')}</pre></td></tr>`,
  );
  const errors = errorRows.length ? section('errors', 'Tool errors', table(['Time', 'Tool', 'Input / error'], errorRows, 99), { count: errorRows.length, collapsible: true }) : '';

  const mcpRows: string[] = [];
  for (const srv of Object.values(s.totalMcp).sort((a, b) => b.calls - a.calls)) {
    for (const t of sortTools(srv.tools)) {
      mcpRows.push(
        `<tr><td>${chip(srv.server, { tone: 'teal' })}</td><td>${esc(t.name)}</td><td class="num">${n(t.calls)}</td><td class="num">${t.errors ? pill(String(t.errors), 'err') : '0'}</td></tr>`,
      );
    }
  }
  const mcp = `<div><h3>MCP tools</h3>${table(['Server', 'Tool', 'Calls', 'Errors'], mcpRows, 2)}</div>`;

  const toolRows = sortTools(s.totalTools).map(
    (t) =>
      `<tr><td class="cell-strong">${esc(t.name)}</td><td class="num">${n(t.calls)}</td><td class="num">${n(m.tools[t.name]?.calls ?? 0)}</td><td class="num">${t.errors ? pill(String(t.errors), 'err') : '0'}</td></tr>`,
  );
  const tools = `<div><h3>Built-in tools</h3>${table(['Tool', 'Calls', 'Main only', 'Errors'], toolRows)}</div>`;

  const skillRows = Object.entries(s.totalSkills)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${n(v)}</td></tr>`);
  const skills = skillRows.length ? `<h3>Skills</h3>${table(['Skill', 'Calls'], skillRows)}` : '';

  const promptItems = m.prompts.map(
    (p) => `<li><span class="ts">${time(p.timestamp)}</span><div class="pt">${esc(p.text)}</div></li>`,
  );
  const prompts = section('prompts', 'User prompts', promptItems.length ? `<ol class="timeline">${promptItems.join('')}</ol>` : '<div class="empty">None</div>', {
    count: m.prompts.length,
    collapsible: true,
  });
  const toolsSection = section('tools', 'Tools', `<div class="grid-2">${tools}${mcp}</div>${skills}`, { count: s.totalToolCalls, collapsible: true });
  const overview = section('overview', 'Cost drivers', `${driversTable}${insights}`, {});
  const navLinks: Array<[string, string]> = [['overview', 'Cost drivers'], ['context', 'Context'], ['tokens', 'Tokens']];
  if (agents) navLinks.push(['agents', 'Subagents']);
  if (commits) navLinks.push(['commits', 'Commits']);
  if (filesSection) navLinks.push(['files', 'Files']);
  if (errors) navLinks.push(['errors', 'Errors']);
  navLinks.push(['tools', 'Tools'], ['prompts', 'Prompts'], ['details', 'Details']);

  const html = page(
    s.title,
    [header, nav(navLinks), overview, contextSection, section('tokens', 'Tokens and cost', tokensBody + models, { collapsible: true }), agents, commits, filesSection, errors, toolsSection, prompts, details].join('\n'),
    nonce,
    cspSource,
  );
  return { html, transcripts, files };
}

function sortTools(tools: Record<string, ToolStat>): ToolStat[] {
  return Object.values(tools).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}
