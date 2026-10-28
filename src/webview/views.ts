// Conversation, dashboard and comparison views (pure HTML, no vscode dependency).
import { CompareMetric, DashboardData } from '../parser/aggregate';
import { UsageBlock } from '../parser/blocks';
import { Conversation } from '../parser/conversation';
import { formatDuration, formatTokens, totalTokens } from '../parser/format';
import { ConfiguredServer } from '../parser/mcpConfig';
import { splitMcpName } from '../parser/parser';
import { cacheHitRate, formatPercent, formatUsd } from '../parser/pricing';
import { SessionSummary } from '../parser/types';
import { action, barChart, chip, esc, hero, kpis, n, nav, page, pill, section, shareBar, table, time, tok } from './html';

const CONVERSATION_STYLE = `
.thread { display: flex; flex-direction: column; gap: 14px; }
.step { display: flex; flex-direction: column; }
.msg { display: flex; gap: 12px; max-width: 86%; }
.msg .avatar { flex: none; width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 9.5px; font-weight: 600; letter-spacing: 0.03em; color: var(--muted); border: 1px solid var(--line-strong); }
.msg.user { align-self: flex-end; flex-direction: row-reverse; }
.bubble { padding: 10px 14px; border-radius: 10px; border: 1px solid var(--line); min-width: 0; }
.msg.user .bubble { background: var(--surface); }
.bubble .who { font-size: 11px; color: var(--muted); margin-bottom: 4px; display: flex; gap: 8px; }
.bubble .who b { color: var(--fg); font-weight: 500; }
.bubble .body { white-space: pre-wrap; word-break: break-word; }
details.tool { margin: 0 0 0 38px; max-width: calc(86% - 38px); border-left: 1px solid var(--line-strong); }
details.tool > summary { cursor: pointer; padding: 3px 12px; display: flex; gap: 10px; align-items: center; list-style: none; font-size: 12px; color: var(--muted); }
details.tool > summary:hover { color: var(--fg); }
details.tool > summary::-webkit-details-marker { display: none; }
details.tool > summary .name { font-weight: 500; color: var(--fg); font-family: var(--mono); }
details.tool > summary .arg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; font-family: var(--mono); font-size: 11.5px; }
details.tool .tool-body { padding: 2px 12px 8px; }
details.tool.error { border-left-color: var(--red); }
.compact { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; margin: 12px 0; }
.compact::before, .compact::after { content: ''; flex: 1; height: 1px; background: var(--line-strong); }
body.hide-tools details.tool { display: none; }
body.replaying .step:not(.shown) { display: none; }
body.replaying .step.current .bubble { border-color: var(--fg); }
body.replaying .step.current details.tool { border-left-color: var(--fg); }
.replay { display: none; gap: 2px; align-items: center; }
body.replaying .replay { display: flex; }
.convbar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 10px 0; margin-bottom: 18px; border-bottom: 1px solid var(--line); background: var(--bg); }
.convbar label { display: inline-flex; gap: 6px; align-items: center; color: var(--muted); font-size: 12px; cursor: pointer; margin-right: 6px; }
.convbar .spacer { flex: 1; }
`;

const SUMMARY_KEYS = ['file_path', 'notebook_path', 'pattern', 'path', 'command', 'description', 'url', 'query', 'skill', 'prompt'];

/** One-line summary of a tool input: the most telling field of a JSON input, or its first line. */
export function toolSummary(input: string): string {
  const text = input.trim();
  if (text.startsWith('{')) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      for (const k of SUMMARY_KEYS) {
        const v = o[k];
        if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').slice(0, 160);
      }
      return JSON.stringify(o).slice(0, 160);
    } catch {
      // truncated JSON: fall through
    }
  }
  return text.split('\n')[0].slice(0, 160);
}

export function renderConversation(title: string, conv: Conversation, nonce: string, cspSource: string): string {
  const tools = conv.entries.filter((e) => e.kind === 'tool').length;
  const users = conv.entries.filter((e) => e.kind === 'user').length;
  const body: string[] = [];
  body.push(
    hero({
      eyebrow: 'Conversation',
      title,
      meta: [chip(`${users} prompts`, {}), chip(`${conv.entries.length - users - tools} replies`, {}), chip(`${tools} tool calls`, {})].join(''),
    }),
  );
  body.push(
    `<div class="convbar"><button class="btn btn-secondary" data-replay="toggle">Replay</button><span class="replay">${[
      ['start', '⏮'],
      ['prev', '◀'],
      ['play', '⏯'],
      ['next', '▶'],
      ['end', '⏭'],
    ]
      .map(([a, l]) => `<button class="btn btn-ghost" data-replay="${a}" title="${a}">${l}</button>`)
      .join('')}<span id="replay-pos" class="muted small"></span></span><span class="spacer"></span><label><input type="checkbox" data-toggle="hide-tools"> Hide tool calls</label>${action('export', 'Export', {})}${action('refresh', 'Refresh', { variant: 'ghost' })}</div>`,
  );
  if (conv.truncated) body.push('<p class="muted">Only the first entries are shown (entry limit reached).</p>');
  if (conv.entries.length === 0) body.push('<div class="empty">No messages.</div>');
  body.push('<div class="thread">');
  conv.entries.forEach((e, step) => {
    const ts = e.timestamp ? ` data-ts="${esc(new Date(e.timestamp).toLocaleString())}"` : '';
    body.push(`<div class="step" data-step="${step}"${ts}>`);
    if (e.kind === 'user' || e.kind === 'assistant') {
      const who = e.kind === 'user' ? 'You' : 'Assistant';
      const meta = [e.kind === 'assistant' ? e.model : undefined, e.timestamp ? new Date(e.timestamp).toLocaleString() : undefined].filter(Boolean).join(' · ');
      body.push(
        `<div class="msg ${e.kind}"><div class="avatar">${e.kind === 'user' ? 'You' : 'AI'}</div><div class="bubble"><div class="who"><b>${who}</b><span>${esc(meta)}</span></div><div class="body">${esc(e.text)}</div></div></div>`,
      );
    } else if (e.kind === 'compact') {
      body.push(`<div class="compact">context compacted${e.timestamp ? ' · ' + esc(new Date(e.timestamp).toLocaleString()) : ''}</div>`);
    } else {
      const mcp = splitMcpName(e.name);
      const label = mcp ? `${mcp.server} › ${mcp.tool}` : e.name;
      const firstLine = toolSummary(e.input);
      const state = e.isError ? pill('error', 'err') : e.result === undefined ? pill('no result', 'muted') : '';
      body.push(
        `<details class="tool${e.isError ? ' error' : ''}"><summary><span class="name">${esc(label)}</span><span class="arg">${esc(firstLine)}</span>${state}</summary><div class="tool-body">${
          e.input ? `<pre>${esc(e.input)}</pre>` : ''
        }${e.result !== undefined ? `<pre class="${e.isError ? 'err' : ''}">${esc(e.result || '(empty)')}</pre>` : ''}</div></details>`,
      );
    }
    body.push('</div>');
  });
  body.push('</div>');
  return page(title, body.join('\n'), nonce, cspSource, CONVERSATION_STYLE);
}

export interface DashboardRenderResult {
  html: string;
  /** Session file paths addressable by index (top sessions table). */
  sessions: string[];
}

export interface DashboardExtras {
  /** All 5-hour blocks (oldest first) across every project. */
  blocks?: UsageBlock[];
  /** Optional token limit per block, to show a percentage. */
  blockTokenLimit?: number;
  unusedMcp?: ConfiguredServer[];
  /** False when the MCP config could not be checked. */
  mcpChecked?: boolean;
}

function renderBlocks(blocks: UsageBlock[], limit: number | undefined): string {
  const fmtTime = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const cur = blocks.find((b) => b.active);
  const out: string[] = [];
  if (cur) {
    const tokens = totalTokens(cur.usage);
    const mins = Math.max(0, Math.round((cur.end - Date.now()) / 60000));
    out.push(
      kpis(
        [
          { label: 'Tokens', value: tok(tokens), sub: limit ? `${esc(((tokens / limit) * 100).toFixed(0))}% of ${esc(formatTokens(limit))}` : 'all projects', tone: 'blue' },
          { label: 'Cost (est.)', value: esc(formatUsd(cur.cost)), tone: 'green' },
          { label: 'Burn rate', value: esc(formatUsd(cur.burnRateUsd ?? 0)) + '<span class="muted small">/h</span>', tone: 'orange' },
          { label: 'Projected', value: esc(formatUsd(cur.projectedCost ?? 0)), sub: 'at the current rate', tone: 'purple' },
          { label: 'Resets in', value: `${Math.floor(mins / 60)}h ${mins % 60}m`, sub: esc(fmtTime(cur.end)), tone: 'teal' },
        ],
        'Current block',
      ),
    );
    if (limit) out.push(`<meter min="0" max="${limit}" value="${Math.min(tokens, limit)}" class="share block-meter tone-${tokens >= limit * 0.9 ? 'red' : 'blue'}"></meter>`);
  } else {
    out.push('<div class="empty">No active block: no usage in the last 5 hours.</div>');
  }
  const recent = blocks.slice(-8).reverse();
  const maxCost = Math.max(1e-9, ...recent.map((b) => b.cost));
  out.push('<h3>Recent blocks</h3>');
  out.push(
    table(
      ['Window', 'Tokens', 'Cost', ''],
      recent.map(
        (b) =>
          `<tr><td>${esc(fmtTime(b.start))} → ${esc(new Date(b.end).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))} ${b.active ? pill('active', 'live') : ''}</td><td class="num">${tok(
            totalTokens(b.usage),
          )}</td><td class="num">${esc(formatUsd(b.cost))}</td><td>${shareBar(b.cost / maxCost, 'green')}</td></tr>`,
      ),
    ),
  );
  out.push('<p class="muted small">A block starts at the hour of the first message after the previous block ended, like subscription usage windows. Approximate.</p>');
  return out.join('\n');
}

export function renderDashboard(d: DashboardData, scopeLabel: string, nonce: string, cspSource: string, extras: DashboardExtras = {}): DashboardRenderResult {
  const sessions: string[] = [];
  const range = d.sinceDay ? `since ${d.sinceDay}` : 'all time';
  const out: string[] = [];
  out.push(
    hero({
      eyebrow: 'AgentWatch',
      title: 'Usage dashboard',
      meta: [chip(scopeLabel, {}), chip(range, {})].join(''),
      actions: [action('range', 'Change range', { variant: 'primary' }), action('refresh', 'Refresh', { variant: 'ghost' })].join(''),
    }),
  );
  const links: Array<[string, string]> = [['summary', 'Summary']];
  if (extras.blocks) links.push(['blocks', '5h blocks']);
  links.push(['trend', 'Trend'], ['breakdown', 'Breakdown'], ['top', 'Top sessions'], ['usage', 'Tools']);
  if (extras.mcpChecked) links.push(['mcp-unused', 'Unused MCP']);
  out.push(nav(links));

  const avg = d.sessions ? d.cost / d.sessions : 0;
  out.push(
    section(
      'summary',
      'Summary',
      kpis([
        { label: 'Cost (est.)', value: esc(formatUsd(d.cost)), sub: `${esc(formatUsd(avg))} per session`, tone: 'green' },
        { label: 'Sessions', value: n(d.sessions), sub: `${n(d.projects.length)} projects`, tone: 'blue' },
        { label: 'Tokens', value: tok(totalTokens(d.usage)), sub: `${tok(d.usage.output)} output`, tone: 'purple' },
        { label: 'Cache hit', value: esc(formatPercent(d.cacheHit)), sub: `${tok(d.usage.cacheRead)} from cache`, tone: 'teal' },
      ]) + (d.unpricedModels.length ? `<p class="muted small">No price for: ${esc(d.unpricedModels.join(', '))} (counted as $0).</p>` : ''),
      {},
    ),
  );
  if (extras.blocks) out.push(section('blocks', '5-hour usage blocks', renderBlocks(extras.blocks, extras.blockTokenLimit), {}));

  const span = d.days.length ? `<div class="axis-note"><span>${esc(d.days[0].day)}</span><span>${esc(d.days[d.days.length - 1].day)}</span></div>` : '';
  out.push(
    section(
      'trend',
      'Daily trend',
      `<div class="grid-2"><div><h3>Cost per day</h3>${barChart(
        d.days.map((r, i) => ({ x: i, y: r.cost, title: `${r.day}: ${formatUsd(r.cost)} · ${formatTokens(totalTokens(r.usage))} tokens` })),
        formatUsd,
        'green',
      )}${span}</div><div><h3>Tokens per day</h3>${barChart(
        d.days.map((r, i) => ({ x: i, y: totalTokens(r.usage), title: `${r.day}: ${formatTokens(totalTokens(r.usage))} tokens` })),
        formatTokens,
        'blue',
      )}${span}</div></div>`,
      {},
    ),
  );

  const maxProject = Math.max(1e-9, ...d.projects.map((p) => p.cost));
  const maxModel = Math.max(1e-9, ...d.models.map((m) => m.cost));
  out.push(
    section(
      'breakdown',
      'Breakdown',
      `<div class="grid-2"><div><h3>Projects</h3>${table(
        ['Project', 'Sessions', 'Tokens', 'Cost', ''],
        d.projects.map(
          (p) =>
            `<tr><td class="cell-strong">${esc(p.project)}</td><td class="num">${n(p.sessions)}</td><td class="num" title="cache hit ${esc(formatPercent(cacheHitRate(p.usage)))}">${tok(
              totalTokens(p.usage),
            )}</td><td class="num">${esc(formatUsd(p.cost))}</td><td>${shareBar(p.cost / maxProject, 'green')}</td></tr>`,
        ),
      )}</div><div><h3>Models</h3>${table(
        ['Model', 'Output', 'Cache read', 'Cost', ''],
        d.models.map(
          (m) =>
            `<tr><td>${chip(m.model, { tone: 'purple' })}</td><td class="num">${tok(m.usage.output)}</td><td class="num">${tok(m.usage.cacheRead)}</td><td class="num">${esc(
              formatUsd(m.cost),
            )}</td><td>${shareBar(m.cost / maxModel, 'purple')}</td></tr>`,
        ),
      )}</div></div>`,
      {},
    ),
  );

  out.push(
    section(
      'top',
      'Most expensive sessions',
      table(
        ['Session', 'Project', 'Last activity', 'Tokens', 'Cost'],
        d.topSessions.map((s) => {
          sessions.push(s.filePath);
          return `<tr><td>${action('openSession', s.title, { index: sessions.length - 1, link: true })}</td><td>${chip(s.project, {})}</td><td class="ts">${time(
            s.endTime,
          )}</td><td class="num">${tok(totalTokens(s.usage))}</td><td class="num cell-strong">${esc(formatUsd(s.cost))}</td></tr>`;
        }),
      ),
      { count: d.topSessions.length },
    ),
  );

  out.push(
    section(
      'usage',
      'Agents and tools',
      `<div class="grid-2"><div><h3>Subagent types</h3>${table(
        ['Agent type', 'Runs', 'Tokens'],
        d.agentTypes.map((a) => `<tr><td class="cell-strong">${esc(a.agentType)}</td><td class="num">${n(a.count)}</td><td class="num">${tok(totalTokens(a.usage))}</td></tr>`),
      )}</div><div><h3>Built-in tools</h3>${table(
        ['Tool', 'Calls', 'Errors'],
        d.tools.map((t) => `<tr><td class="cell-strong">${esc(t.name)}</td><td class="num">${n(t.calls)}</td><td class="num">${t.errors ? pill(String(t.errors), 'err') : '0'}</td></tr>`),
      )}</div></div><h3>MCP tools</h3>${table(
        ['Server', 'Tool', 'Calls', 'Errors'],
        d.mcpTools.map(
          (t) =>
            `<tr><td>${chip(t.server, { tone: 'teal' })}</td><td>${esc(t.tool)}</td><td class="num">${n(t.calls)}</td><td class="num">${t.errors ? pill(String(t.errors), 'err') : '0'}</td></tr>`,
        ),
        2,
      )}<p class="muted small">Tokens and cost are split by day; tool and subagent counts include whole sessions that had usage in the range.</p>`,
      { collapsible: true },
    ),
  );

  if (extras.mcpChecked) {
    out.push(
      section(
        'mcp-unused',
        'Configured MCP servers not used',
        extras.unusedMcp?.length
          ? table(
              ['Server', 'Scope', 'Project'],
              extras.unusedMcp.map((c) => `<tr><td>${chip(c.name, { tone: 'orange' })}</td><td>${pill(c.scope, 'muted')}</td><td class="muted">${esc(c.project ?? '')}</td></tr>`),
              99,
            ) +
              '<p class="muted small">Every connected MCP server adds its tool definitions to the context of each session. Disable servers you do not use (<code>claude mcp remove</code> or <code>/mcp</code>).</p>'
          : '<div class="empty">All configured servers were used.</div>',
        { count: extras.unusedMcp?.length ?? 0 },
      ),
    );
  }
  return { html: page('AgentWatch dashboard', out.join('\n'), nonce, cspSource), sessions };
}

function fmt(v: number | undefined, f: CompareMetric['format']): string {
  if (v === undefined) return '-';
  switch (f) {
    case 'tokens':
      return formatTokens(v);
    case 'usd':
      return formatUsd(v);
    case 'percent':
      return formatPercent(v);
    case 'duration':
      return formatDuration(v);
    default:
      return v.toLocaleString('en-US');
  }
}

const COMPARE_STYLE = `
.vs { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; margin-bottom: 8px; }
.vs .side { padding: 16px 18px; background: var(--bg); min-width: 0; }
.vs .badge { display: inline-flex; width: 20px; height: 20px; border-radius: 4px; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; border: 1px solid var(--line-strong); color: var(--muted); margin-right: 10px; }
.vs .mid { display: none; }
.vs .t { font-weight: 500; font-size: 14px; display: flex; align-items: center; }
.vs .chips { margin-top: 10px; }
@media (max-width: 640px) { .vs { grid-template-columns: 1fr; } }
`;

export function renderCompare(a: SessionSummary, b: SessionSummary, metrics: CompareMetric[], nonce: string, cspSource: string): string {
  const rows = metrics.map((m) => {
    let delta = '<span class="muted">=</span>';
    if (m.a !== undefined && m.b !== undefined) {
      const diff = m.b - m.a;
      if (diff !== 0) {
        const pct = m.a !== 0 ? ` (${diff > 0 ? '+' : ''}${((diff / Math.abs(m.a)) * 100).toFixed(0)}%)` : '';
        const text = (diff > 0 ? '+' : '−') + (m.format === 'percent' ? (Math.abs(diff) * 100).toFixed(1) + ' pt' : fmt(Math.abs(diff), m.format)) + (m.format === 'percent' ? '' : pct);
        const better = m.lowerIsBetter ? diff < 0 : diff > 0;
        delta = pill(text, better ? 'ok' : 'err');
      }
    }
    return `<tr><td class="cell-strong">${esc(m.label)}</td><td class="num">${esc(fmt(m.a, m.format))}</td><td class="num">${esc(fmt(m.b, m.format))}</td><td class="num">${delta}</td></tr>`;
  });
  const side = (cls: 'a' | 'b', s: SessionSummary, i: number) =>
    `<div class="side ${cls}"><div class="t"><span class="badge">${cls.toUpperCase()}</span>${action('openSession', s.title, { index: i, link: true })}</div><div class="chips">${[
      s.main.cwd ? chip(s.main.cwd.split(/[\\/]/).pop() ?? s.main.cwd, { title: s.main.cwd }) : '',
      s.main.gitBranch ? chip(s.main.gitBranch, { mono: true }) : '',
      ...s.models.map((m) => chip(m, { tone: 'purple' })),
      s.main.startTime ? chip(new Date(s.main.startTime).toLocaleString(), {}) : '',
    ].join('')}</div></div>`;
  const body = `${hero({ eyebrow: 'AgentWatch', title: 'Compare sessions' })}
<div class="vs">${side('a', a, 0)}<div class="mid">VS</div>${side('b', b, 1)}</div>
${section('metrics', 'Metrics', `${table(['Metric', 'A', 'B', 'B − A'], rows)}<p class="muted small">Green means B is better (lower cost, tokens or errors; higher cache hit). Costs are estimates.</p>`, {})}`;
  return page('Compare sessions', body, nonce, cspSource, COMPARE_STYLE);
}
