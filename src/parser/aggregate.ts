// Cross-session aggregation (dashboard) and two-session comparison. No vscode dependency.
import { addUsage, emptyUsage, totalTokens } from './format';
import { localDay } from './parser';
import { cacheHitRate, Pricing } from './pricing';
import { SessionSummary, SubagentNode, TokenUsage } from './types';

export interface DashboardSession {
  summary: SessionSummary;
  /** Display name of the project (cwd basename or decoded folder). */
  project: string;
}

export interface DayRow {
  day: string;
  usage: TokenUsage;
  cost: number;
}

export interface DashboardData {
  sinceDay?: string;
  sessions: number;
  usage: TokenUsage;
  cost: number;
  cacheHit?: number;
  days: DayRow[];
  projects: Array<{ project: string; sessions: number; usage: TokenUsage; cost: number }>;
  models: Array<{ model: string; usage: TokenUsage; cost: number }>;
  mcpTools: Array<{ server: string; tool: string; calls: number; errors: number }>;
  tools: Array<{ name: string; calls: number; errors: number }>;
  agentTypes: Array<{ agentType: string; count: number; usage: TokenUsage }>;
  topSessions: Array<{ filePath: string; title: string; project: string; usage: TokenUsage; cost: number; endTime?: string }>;
  unpricedModels: string[];
}

function walkAgents(list: SubagentNode[], fn: (a: SubagentNode) => void): void {
  const stack = [...list];
  while (stack.length) {
    const a = stack.pop()!;
    fn(a);
    stack.push(...a.children);
  }
}

/**
 * Aggregate sessions. Usage is attributed to days via each session's per-day breakdown, so with
 * `sinceDay` only usage on or after that day is counted (a long session can straddle the cutoff).
 */
export function buildDashboard(
  sessions: DashboardSession[],
  pricing: Pricing,
  sinceDay?: string,
  topN = 15,
): DashboardData {
  const usage = emptyUsage();
  let cost = 0;
  const days = new Map<string, DayRow>();
  const projects = new Map<string, { project: string; sessions: number; usage: TokenUsage; cost: number }>();
  const models = new Map<string, { model: string; usage: TokenUsage; cost: number }>();
  const mcp = new Map<string, { server: string; tool: string; calls: number; errors: number }>();
  const tools = new Map<string, { name: string; calls: number; errors: number }>();
  const agentTypes = new Map<string, { agentType: string; count: number; usage: TokenUsage }>();
  const unpriced = new Set<string>();
  const top: DashboardData['topSessions'] = [];
  let counted = 0;

  for (const { summary: s, project } of sessions) {
    const sUsage = emptyUsage();
    let sCost = 0;
    for (const [day, byModel] of Object.entries(s.totalByDay)) {
      if (sinceDay && day < sinceDay) continue;
      const row = days.get(day) ?? { day, usage: emptyUsage(), cost: 0 };
      days.set(day, row);
      for (const [model, mu] of Object.entries(byModel)) {
        const c = pricing.cost(model, mu);
        addUsage(row.usage, mu);
        row.cost += c;
        addUsage(sUsage, mu);
        sCost += c;
        const m = models.get(model) ?? { model, usage: emptyUsage(), cost: 0 };
        models.set(model, m);
        addUsage(m.usage, mu);
        m.cost += c;
      }
    }
    if (totalTokens(sUsage) === 0) continue;
    counted++;
    for (const m of pricing.unpriced(s.totalByModel)) unpriced.add(m);
    addUsage(usage, sUsage);
    cost += sCost;
    const p = projects.get(project) ?? { project, sessions: 0, usage: emptyUsage(), cost: 0 };
    projects.set(project, p);
    p.sessions++;
    addUsage(p.usage, sUsage);
    p.cost += sCost;
    // Call counts are not split by day; they count whole sessions that had usage in range.
    for (const srv of Object.values(s.totalMcp)) {
      for (const t of Object.values(srv.tools)) {
        const key = srv.server + '\u0000' + t.name;
        const d = mcp.get(key) ?? { server: srv.server, tool: t.name, calls: 0, errors: 0 };
        mcp.set(key, d);
        d.calls += t.calls;
        d.errors += t.errors;
      }
    }
    for (const t of Object.values(s.totalTools)) {
      const d = tools.get(t.name) ?? { name: t.name, calls: 0, errors: 0 };
      tools.set(t.name, d);
      d.calls += t.calls;
      d.errors += t.errors;
    }
    walkAgents(s.subagents, (a) => {
      const d = agentTypes.get(a.agentType) ?? { agentType: a.agentType, count: 0, usage: emptyUsage() };
      agentTypes.set(a.agentType, d);
      d.count++;
      addUsage(d.usage, a.stats.usage);
    });
    top.push({ filePath: s.filePath, title: s.title, project, usage: sUsage, cost: sCost, endTime: s.main.endTime });
  }

  const byTokens = <T extends { usage: TokenUsage }>(a: T, b: T) => totalTokens(b.usage) - totalTokens(a.usage);
  return {
    sinceDay,
    sessions: counted,
    usage,
    cost,
    cacheHit: cacheHitRate(usage),
    days: fillDays([...days.values()], sinceDay),
    projects: [...projects.values()].sort((a, b) => b.cost - a.cost || byTokens(a, b)),
    models: [...models.values()].filter((m) => totalTokens(m.usage) > 0).sort((a, b) => b.cost - a.cost || byTokens(a, b)),
    mcpTools: [...mcp.values()].sort((a, b) => b.calls - a.calls).slice(0, topN),
    tools: [...tools.values()].sort((a, b) => b.calls - a.calls).slice(0, topN),
    agentTypes: [...agentTypes.values()].sort(byTokens).slice(0, topN),
    topSessions: top.sort((a, b) => b.cost - a.cost || byTokens(a, b)).slice(0, topN),
    unpricedModels: [...unpriced].sort(),
  };
}

/** Sorted day rows with empty days filled in (from sinceDay, or the first day with usage, to today). */
function fillDays(rows: DayRow[], sinceDay?: string): DayRow[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const sorted = [...byDay.keys()].sort();
  const first = sinceDay ?? sorted[0];
  if (!first) return [];
  const today = localDay(Date.now());
  const last = sorted.length && sorted[sorted.length - 1] > today ? sorted[sorted.length - 1] : today;
  const out: DayRow[] = [];
  const [y, m, d] = first.split('-').map(Number);
  const cur = new Date(y, m - 1, d);
  // Bounded: at most ~10 years of days.
  for (let i = 0; i < 3660; i++) {
    const key = localDay(cur.getTime());
    if (key > last) break;
    out.push(byDay.get(key) ?? { day: key, usage: emptyUsage(), cost: 0 });
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/** Local day `n` days before today (n = 0 is today). */
export function dayNDaysAgo(n: number, now = Date.now()): string {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return localDay(d.getTime());
}

/** Cost of a session on one local day. */
export function sessionCostOnDay(s: SessionSummary, day: string, pricing: Pricing): number {
  const byModel = s.totalByDay[day];
  return byModel ? pricing.costByModel(byModel) : 0;
}

export interface CompareMetric {
  label: string;
  a: number | undefined;
  b: number | undefined;
  format: 'tokens' | 'usd' | 'percent' | 'duration' | 'count';
  /** True when a lower value is better (used to colour the delta). */
  lowerIsBetter?: boolean;
}

export function compareSessions(a: SessionSummary, b: SessionSummary, pricing: Pricing): CompareMetric[] {
  const m = (label: string, f: (s: SessionSummary) => number | undefined, format: CompareMetric['format'], lowerIsBetter = true) => ({
    label,
    a: f(a),
    b: f(b),
    format,
    lowerIsBetter,
  });
  const mcpCalls = (s: SessionSummary) => Object.values(s.totalMcp).reduce((n, x) => n + x.calls, 0);
  const toolErrors = (s: SessionSummary) =>
    Object.values(s.totalTools).reduce((n, x) => n + x.errors, 0) + Object.values(s.totalMcp).reduce((n, x) => n + x.errors, 0);
  return [
    m('Cost (estimate)', (s) => pricing.costByModel(s.totalByModel), 'usd'),
    m('Total tokens', (s) => totalTokens(s.totalUsage), 'tokens'),
    m('Input', (s) => s.totalUsage.input, 'tokens'),
    m('Output', (s) => s.totalUsage.output, 'tokens'),
    m('Cache write', (s) => s.totalUsage.cacheWrite, 'tokens'),
    m('Cache read', (s) => s.totalUsage.cacheRead, 'tokens', false),
    m('Cache hit rate', (s) => cacheHitRate(s.totalUsage), 'percent', false),
    m('Main thread tokens', (s) => totalTokens(s.main.usage), 'tokens'),
    m('Duration', (s) => s.durationMs, 'duration'),
    m('API messages (main)', (s) => s.main.apiMessages, 'count'),
    m('User prompts', (s) => s.main.prompts.length, 'count'),
    m('Tool calls', (s) => s.totalToolCalls, 'count'),
    m('MCP calls', mcpCalls, 'count'),
    m('Tool errors', toolErrors, 'count'),
    m('Subagents', (s) => s.agentCount, 'count'),
    m('Files edited', (s) => Object.keys(s.totalFileEdits).length, 'count'),
    m('Compactions (main)', (s) => s.main.compactions.length, 'count'),
    m('Peak context (main)', (s) => s.main.context.reduce((mx, p) => Math.max(mx, p.tokens), 0), 'tokens'),
  ];
}
