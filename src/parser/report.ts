// Usage report exports (CSV, JSON, Markdown). No vscode dependency.
import { DashboardData, DashboardSession } from './aggregate';
import { formatTokens, totalTokens } from './format';
import { cacheHitRate, formatPercent, formatUsd, Pricing } from './pricing';

/**
 * CSV cell: quoted when needed, and prefixed with ' when it starts with a formula character so
 * spreadsheets do not execute transcript-controlled text (CSV injection).
 */
export function csvCell(v: unknown): string {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface SessionRow {
  start?: string;
  end?: string;
  project: string;
  title: string;
  sessionId: string;
  models: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
  costUsd: number;
  reportedCostUsd?: number;
  toolCalls: number;
  subagents: number;
  commits: number;
  filesChanged: number;
}

export function sessionRows(sessions: DashboardSession[], pricing: Pricing): SessionRow[] {
  return sessions
    .map(({ summary: s, project }) => ({
      start: s.main.startTime,
      end: s.main.endTime,
      project,
      title: s.title,
      sessionId: s.sessionId,
      models: s.models.join(' '),
      input: s.totalUsage.input,
      output: s.totalUsage.output,
      cacheWrite: s.totalUsage.cacheWrite,
      cacheRead: s.totalUsage.cacheRead,
      total: totalTokens(s.totalUsage),
      costUsd: Math.round(pricing.costByModel(s.totalByModel) * 10000) / 10000,
      reportedCostUsd: s.main.reportedCostUsd,
      toolCalls: s.totalToolCalls,
      subagents: s.agentCount,
      commits: s.main.commits.filter((c) => !c.failed).length,
      filesChanged: Object.keys(s.totalFileEdits).length,
    }))
    .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
}

const COLUMNS: Array<keyof SessionRow> = [
  'start', 'end', 'project', 'title', 'sessionId', 'models', 'input', 'output', 'cacheWrite', 'cacheRead',
  'total', 'costUsd', 'reportedCostUsd', 'toolCalls', 'subagents', 'commits', 'filesChanged',
];

export function rowsToCsv(rows: SessionRow[]): string {
  return [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}

export function reportToJson(d: DashboardData, rows: SessionRow[]): string {
  return JSON.stringify({ generatedAt: new Date().toISOString(), summary: d, sessions: rows }, null, 2);
}

function md(v: unknown): string {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function reportToMarkdown(d: DashboardData, rows: SessionRow[], scope: string): string {
  const out: string[] = [];
  out.push(`# Claude Code usage report`, '', `${md(scope)} · ${d.sinceDay ? `since ${d.sinceDay}` : 'all time'} · generated ${new Date().toLocaleString()}`, '');
  out.push(
    `- Sessions: **${d.sessions}**`,
    `- Tokens: **${formatTokens(totalTokens(d.usage))}** (output ${formatTokens(d.usage.output)})`,
    `- Estimated cost: **${formatUsd(d.cost)}**`,
    `- Cache hit rate: **${formatPercent(cacheHitRate(d.usage))}**`,
    '',
  );
  out.push('## Per day', '', '| Day | Tokens | Cost |', '| --- | ---: | ---: |');
  for (const r of d.days) if (totalTokens(r.usage)) out.push(`| ${r.day} | ${formatTokens(totalTokens(r.usage))} | ${formatUsd(r.cost)} |`);
  out.push('', '## Projects', '', '| Project | Sessions | Tokens | Cost |', '| --- | ---: | ---: | ---: |');
  for (const p of d.projects) out.push(`| ${md(p.project)} | ${p.sessions} | ${formatTokens(totalTokens(p.usage))} | ${formatUsd(p.cost)} |`);
  out.push('', '## Models', '', '| Model | Tokens | Cost |', '| --- | ---: | ---: |');
  for (const m of d.models) out.push(`| ${md(m.model)} | ${formatTokens(totalTokens(m.usage))} | ${formatUsd(m.cost)} |`);
  out.push('', '## Top sessions', '', '| Session | Project | Tokens | Cost |', '| --- | --- | ---: | ---: |');
  for (const s of d.topSessions) out.push(`| ${md(s.title)} | ${md(s.project)} | ${formatTokens(totalTokens(s.usage))} | ${formatUsd(s.cost)} |`);
  if (d.mcpTools.length) {
    out.push('', '## Top MCP tools', '', '| Server | Tool | Calls | Errors |', '| --- | --- | ---: | ---: |');
    for (const t of d.mcpTools) out.push(`| ${md(t.server)} | ${md(t.tool)} | ${t.calls} | ${t.errors} |`);
  }
  const commits = rows.reduce((n, r) => n + r.commits, 0);
  out.push('', `Commits made by sessions in range: **${commits}**.`, '');
  return out.join('\n');
}
