// Markdown export of a session. No vscode dependency.
import { Conversation } from './conversation';
import { formatDuration, formatTokens, totalTokens } from './format';
import { cacheHitRate, formatPercent, formatUsd, Pricing } from './pricing';
import { SessionSummary, TokenUsage } from './types';

/** Fence that is longer than any backtick run inside `text`. */
function fence(text: string): string {
  let longest = 2;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(longest + 1);
}

function codeBlock(text: string, lang = ''): string {
  const f = fence(text);
  return `${f}${lang}\n${text}\n${f}`;
}

/** Escape characters that would break a Markdown table cell. */
function cell(v: unknown): string {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function usageRow(label: string, u: TokenUsage, cost?: number): string {
  return `| ${cell(label)} | ${formatTokens(u.input)} | ${formatTokens(u.output)} | ${formatTokens(u.cacheWrite)} | ${formatTokens(u.cacheRead)} | ${formatTokens(totalTokens(u))} | ${cost === undefined ? '' : formatUsd(cost)} |`;
}

export interface ExportOptions {
  /** Include tool call inputs/results in the conversation section. */
  includeTools: boolean;
  tags?: string[];
  note?: string;
}

export function sessionToMarkdown(
  s: SessionSummary,
  conversation: Conversation | undefined,
  pricing: Pricing,
  opts: ExportOptions = { includeTools: true },
): string {
  const m = s.main;
  const out: string[] = [];
  const cost = pricing.costByModel(s.totalByModel);
  out.push(`# ${s.title.replace(/\r?\n/g, ' ')}`, '');
  out.push('| | |', '| --- | --- |');
  const kv: Array<[string, string | undefined]> = [
    ['Session', s.sessionId],
    ['Project', m.cwd],
    ['Branch', m.gitBranch],
    ['Models', s.models.join(', ')],
    ['Start', m.startTime],
    ['End', m.endTime],
    ['Duration', formatDuration(s.durationMs)],
    ['CLI version', m.version],
    ['Tags', opts.tags?.length ? opts.tags.join(', ') : undefined],
    ['Note', opts.note],
  ];
  for (const [k, v] of kv) if (v) out.push(`| ${k} | ${cell(v)} |`);
  out.push('');

  out.push('## Tokens and cost', '');
  out.push(`Estimated cost: **${formatUsd(cost)}** · cache hit rate: **${formatPercent(cacheHitRate(s.totalUsage))}**`, '');
  out.push('| Scope | Input | Output | Cache write | Cache read | Total | Cost |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  out.push(usageRow('Session incl. subagents', s.totalUsage, cost));
  out.push(usageRow('Main thread', m.usage, pricing.costByModel(m.usageByModel)));
  for (const [model, u] of Object.entries(s.totalByModel).sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]))) {
    out.push(usageRow(model, u, pricing.cost(model, u)));
  }
  out.push('');

  if (s.agentCount) {
    out.push(`## Subagents (${s.agentCount})`, '');
    const stack = [...s.subagents].reverse();
    while (stack.length) {
      const a = stack.pop()!;
      const tok = a.transcriptPath ? formatTokens(totalTokens(a.totalUsage)) : `~${formatTokens(a.reportedTokens ?? 0)}`;
      out.push(`${'  '.repeat(a.depth - 1)}- **${cell(a.agentType)}** ${cell(a.description)} (${tok} tok${a.status ? ', ' + cell(a.status) : ''})`);
      for (let i = a.children.length - 1; i >= 0; i--) stack.push(a.children[i]);
    }
    out.push('');
  }

  const tools = Object.values(s.totalTools).sort((a, b) => b.calls - a.calls);
  const mcp = Object.values(s.totalMcp).flatMap((srv) => Object.values(srv.tools).map((t) => ({ ...t, name: `${srv.server} / ${t.name}` })));
  if (tools.length || mcp.length) {
    out.push('## Tools', '', '| Tool | Calls | Errors |', '| --- | ---: | ---: |');
    for (const t of [...tools, ...mcp.sort((a, b) => b.calls - a.calls)]) out.push(`| ${cell(t.name)} | ${t.calls} | ${t.errors} |`);
    out.push('');
  }

  const files = Object.values(s.totalFileEdits).sort((a, b) => a.path.localeCompare(b.path));
  if (files.length) {
    out.push(`## Files changed (${files.length})`, '', '| File | Edits | Writes | Failed |', '| --- | ---: | ---: | ---: |');
    for (const f of files) out.push(`| ${cell(f.path)} | ${f.edits} | ${f.writes} | ${f.failed} |`);
    out.push('');
  }

  if (s.totalToolErrors.length) {
    out.push(`## Tool errors (${s.totalToolErrors.length})`, '');
    for (const e of s.totalToolErrors) {
      out.push(`- **${cell(e.tool)}**${e.agent ? ` (${cell(e.agent)})` : ''}${e.timestamp ? ` · ${e.timestamp}` : ''}`);
      if (e.error) out.push('', codeBlock(e.error), '');
    }
    out.push('');
  }

  if (conversation) {
    out.push('## Conversation', '');
    if (conversation.truncated) out.push('_Conversation truncated (entry limit reached)._', '');
    for (const e of conversation.entries) {
      if (e.kind === 'user') out.push(`### 🧑 User${e.timestamp ? ` · ${e.timestamp}` : ''}`, '', e.text, '');
      else if (e.kind === 'assistant') out.push(`### 🤖 Assistant${e.model ? ` (${e.model})` : ''}`, '', e.text, '');
      else if (e.kind === 'compact') out.push('---', '', '_Context compacted._', '', '---', '');
      else if (opts.includeTools) {
        out.push(`<details><summary>🔧 ${cell(e.name).replace(/</g, '&lt;')}${e.isError ? ' (error)' : ''}</summary>`, '');
        if (e.input) out.push(codeBlock(e.input), '');
        if (e.result !== undefined) out.push('Result:', '', codeBlock(e.result), '');
        out.push('</details>', '');
      }
    }
  }
  return out.join('\n');
}
