// Session list filter (time range, text, pinned). No vscode dependency.
import { SessionAnnotation } from './annotations';
import { SessionFileInfo, SessionPeek } from './parser/store';
import { SessionSummary } from './parser/types';

export interface SessionFilter {
  /** Only sessions modified within this many days (0 = today). */
  sinceDays?: number;
  /** Case-insensitive substring over title, first prompt, cwd, branch, tags, note, models, MCP servers. */
  query?: string;
  pinnedOnly?: boolean;
}

export function isFilterEmpty(f: SessionFilter): boolean {
  return f.sinceDays === undefined && !f.query && !f.pinnedOnly;
}

/** Start of the local day `days` days ago, in epoch ms. */
export function sinceMs(days: number, now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.getTime();
}

export function matchesFilter(
  f: SessionFilter,
  info: SessionFileInfo,
  peek: SessionPeek | undefined,
  summary: SessionSummary | undefined,
  ann: SessionAnnotation,
  now = Date.now(),
): boolean {
  if (f.pinnedOnly && !ann.pinned) return false;
  if (f.sinceDays !== undefined && info.mtimeMs < sinceMs(f.sinceDays, now)) return false;
  const q = f.query?.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    info.sessionId,
    summary?.title,
    peek?.title,
    peek?.firstPrompt,
    peek?.cwd ?? summary?.main.cwd,
    peek?.gitBranch ?? summary?.main.gitBranch,
    ...(ann.tags ?? []).map((t) => '#' + t),
    ann.note,
    ...(summary?.models ?? []),
    ...(summary ? Object.keys(summary.totalMcp) : []),
  ];
  return hay.some((h) => typeof h === 'string' && h.toLowerCase().includes(q));
}

export function describeFilter(f: SessionFilter): string | undefined {
  const parts: string[] = [];
  if (f.pinnedOnly) parts.push('pinned');
  if (f.sinceDays !== undefined) parts.push(f.sinceDays === 0 ? 'today' : `last ${f.sinceDays}d`);
  if (f.query) parts.push(`"${f.query}"`);
  return parts.length ? parts.join(' · ') : undefined;
}
