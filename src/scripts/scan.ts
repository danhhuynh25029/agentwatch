// Smoke test: print summaries for the N newest sessions (plus any paths given as arguments).
// Usage: node out/scripts/scan.js [--dir <projectsDir>] [-n 5] [extra.jsonl ...]
import * as path from 'path';
import { formatDuration, formatTokens, totalTokens } from '../parser/format';
import { expandHome, listProjects, SessionStore } from '../parser/store';
import { SessionSummary, SubagentNode, TokenUsage } from '../parser/types';

function usageLine(u: TokenUsage): string {
  return `in ${formatTokens(u.input)} / out ${formatTokens(u.output)} / cacheW ${formatTokens(u.cacheWrite)} / cacheR ${formatTokens(u.cacheRead)} = ${formatTokens(totalTokens(u))}`;
}

function printAgents(list: SubagentNode[], indent: string): void {
  for (const a of list) {
    const tok = a.transcriptPath ? formatTokens(totalTokens(a.stats.usage)) : `~${formatTokens(a.reportedTokens ?? 0)} (reported)`;
    console.log(
      `${indent}- ${a.agentType} · ${a.description} [${a.model ?? '?'}] ${tok} tok, ${a.stats.toolCalls} tools, ${formatDuration(a.durationMs)}, ${a.status ?? '-'}`,
    );
    printAgents(a.children, indent + '  ');
  }
}

function print(s: SessionSummary): void {
  const m = s.main;
  console.log(`\n=== ${s.title}`);
  console.log(`  file:    ${s.filePath}`);
  console.log(`  cwd:     ${m.cwd ?? '-'}  branch: ${m.gitBranch ?? '-'}  v${m.version ?? '?'}  (${m.entrypoint ?? '-'})`);
  console.log(`  time:    ${m.startTime ?? '-'} -> ${m.endTime ?? '-'} (${formatDuration(s.durationMs)})`);
  console.log(`  models:  ${s.models.join(', ') || '-'}`);
  console.log(`  lines:   ${m.lines} (bad ${m.badLines}), api msgs ${m.apiMessages}, prompts ${m.prompts.length}`);
  console.log(`  main:    ${usageLine(m.usage)}`);
  console.log(`  total:   ${usageLine(s.totalUsage)}`);
  const tools = Object.values(s.totalTools).sort((a, b) => b.calls - a.calls);
  console.log(`  tools:   ${tools.map((t) => `${t.name}=${t.calls}${t.errors ? `(${t.errors} err)` : ''}`).join(', ') || '-'}`);
  const mcp = Object.values(s.totalMcp);
  if (mcp.length) {
    for (const srv of mcp) {
      const tl = Object.values(srv.tools).map((t) => `${t.name}=${t.calls}`).join(', ');
      console.log(`  mcp:     ${srv.server} (${srv.calls} calls, ${srv.errors} err): ${tl}`);
    }
  }
  const skills = Object.entries(s.totalSkills);
  if (skills.length) console.log(`  skills:  ${skills.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`  agents:  ${s.agentCount}`);
  printAgents(s.subagents, '    ');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let dir = '~/.claude/projects';
  let n = 5;
  const extra: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir') dir = args[++i];
    else if (args[i] === '-n') n = Number(args[++i]) || n;
    else extra.push(args[i]);
  }
  const root = expandHome(dir);
  const projects = await listProjects(root);
  const sessions = projects.flatMap((p) => p.sessions).sort((a, b) => b.mtimeMs - a.mtimeMs);
  console.log(`${projects.length} projects, ${sessions.length} sessions in ${root}`);
  const store = new SessionStore();
  const t0 = Date.now();
  for (const info of sessions.slice(0, n)) print(await store.getSummary(info));
  for (const p of extra) print(await store.getSummaryByPath(path.resolve(expandHome(p))));
  console.log(`\nparsed in ${Date.now() - t0} ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
