// Heuristic optimisation hints for a session. No vscode dependency.
import { splitMcpName } from './parser';
import { cacheHitRate, formatPercent, formatUsd, Pricing } from './pricing';
import { SessionSummary, SubagentNode } from './types';
import { formatTokens } from './format';

export interface Insight {
  severity: 'info' | 'warn';
  title: string;
  detail: string;
}

/** Rough token estimate for tool result text (about 4 characters per token). */
export function approxTokens(chars: number): number {
  return Math.round(chars / 4);
}

const LOW_CACHE_HIT = 0.7;
const MIN_PROMPT_FOR_CACHE_HINT = 200_000;
const REPEATED_READS = 4;
const LARGE_RESULT_TOKENS = 20_000;
const REPEATED_ERROR = 3;
const EXPENSIVE_SUBAGENT_USD = 0.5;
const MANY_COMPACTIONS = 2;

function walk(list: SubagentNode[], fn: (a: SubagentNode) => void): void {
  const stack = [...list];
  while (stack.length) {
    const a = stack.pop()!;
    fn(a);
    stack.push(...a.children);
  }
}

export function sessionInsights(s: SessionSummary, pricing: Pricing): Insight[] {
  const out: Insight[] = [];
  const u = s.totalUsage;
  const prompt = u.input + u.cacheWrite + u.cacheRead;
  const hit = cacheHitRate(u);
  if (hit !== undefined && prompt >= MIN_PROMPT_FOR_CACHE_HINT && hit < LOW_CACHE_HIT) {
    out.push({
      severity: 'warn',
      title: `Low cache hit rate (${formatPercent(hit)})`,
      detail:
        'Most prompt tokens were written to or missed the cache. Long pauses (over 5 minutes), switching models, or editing CLAUDE.md/tools mid-session reset the cache.',
    });
  }

  const reads = Object.values(s.totalFileReads)
    .filter((r) => r.reads >= REPEATED_READS)
    .sort((a, b) => b.reads - a.reads);
  if (reads.length) {
    out.push({
      severity: 'info',
      title: `${reads.length} file(s) read ${REPEATED_READS}+ times`,
      detail: reads
        .slice(0, 5)
        .map((r) => `${r.path} (${r.reads}×, ~${formatTokens(approxTokens(r.chars))} tok)`)
        .join('; '),
    });
  }

  const big = s.totalLargestResults.filter((r) => approxTokens(r.chars) >= LARGE_RESULT_TOKENS);
  if (big.length) {
    out.push({
      severity: 'warn',
      title: `${big.length} tool result(s) over ~${formatTokens(LARGE_RESULT_TOKENS)} tokens`,
      detail:
        big
          .slice(0, 3)
          .map((r) => `${r.tool}: ~${formatTokens(approxTokens(r.chars))} tok`)
          .join('; ') + '. Large outputs fill the context; narrower reads, `head`/`grep`, or MCP filters help.',
    });
  }

  const errorKinds = new Map<string, number>();
  for (const e of s.totalToolErrors) {
    const key = `${e.tool}: ${e.error.replace(/\s+/g, ' ').slice(0, 60)}`;
    errorKinds.set(key, (errorKinds.get(key) ?? 0) + 1);
  }
  for (const [key, count] of errorKinds) {
    if (count >= REPEATED_ERROR) out.push({ severity: 'warn', title: `Same tool error ${count}×`, detail: key });
  }

  for (const srv of Object.values(s.totalMcp)) {
    if (srv.calls >= 3 && srv.errors / srv.calls >= 0.5) {
      out.push({
        severity: 'warn',
        title: `MCP server "${srv.server}" failed ${srv.errors}/${srv.calls} calls`,
        detail: 'Check its configuration or connection; failed calls still cost tokens.',
      });
    }
  }

  const expensive: string[] = [];
  walk(s.subagents, (a) => {
    if (!a.transcriptPath || !a.model || !/opus|fable|mythos/i.test(a.model)) return;
    const cost = pricing.costByModel(a.stats.usageByModel);
    if (cost >= EXPENSIVE_SUBAGENT_USD) expensive.push(`${a.agentType} (${formatUsd(cost)})`);
  });
  if (expensive.length) {
    out.push({
      severity: 'info',
      title: `${expensive.length} subagent(s) ran on a top-tier model`,
      detail: `${expensive.slice(0, 5).join(', ')}. For search/exploration agents, setting \`model: sonnet\` or \`haiku\` in the agent definition is usually much cheaper.`,
    });
  }

  if (s.main.compactions.length >= MANY_COMPACTIONS) {
    out.push({
      severity: 'info',
      title: `Context was compacted ${s.main.compactions.length} times`,
      detail: 'Long sessions lose detail at each compaction. Splitting work into separate sessions or delegating to subagents keeps the main context smaller.',
    });
  }

  const unpriced = pricing.unpriced(s.totalByModel);
  if (unpriced.length) {
    out.push({ severity: 'info', title: 'Some models have no price', detail: `${unpriced.join(', ')} counted as $0. Add them with agentwatch.pricing.` });
  }
  return out;
}

/** Human label for a tool name (MCP tools as server › tool). */
export function toolLabel(name: string): string {
  const m = splitMcpName(name);
  return m ? `${m.server} › ${m.tool}` : name;
}
