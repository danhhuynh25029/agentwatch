import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { addUsage, emptyUsage, totalTokens, truncate } from './format';
import {
  AgentMeta,
  AgentSpawn,
  AgentSpawnResult,
  McpServerStat,
  ModelUsage,
  PromptEntry,
  SessionSummary,
  SubagentNode,
  TokenUsage,
  ToolStat,
  TranscriptStats,
} from './types';

/** Tool names that spawn a subagent ("Task" in older Claude Code versions). */
const AGENT_TOOL_NAMES = new Set(['Agent', 'Task']);
const MAX_PROMPTS = 500;
const MAX_PROMPT_CHARS = 300;
const MAX_SUBAGENT_DIR_DEPTH = 4;
const SUBAGENT_PARSE_CONCURRENCY = 4;

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Split `mcp__<server>__<tool>` on the LAST `__`. Returns undefined for non-MCP names. */
export function splitMcpName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined;
  const rest = name.slice('mcp__'.length);
  const idx = rest.lastIndexOf('__');
  if (idx <= 0) return { server: rest || '(unknown)', tool: '(unknown)' };
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) || '(unknown)' };
}

const NOISE_TAG_RE =
  /<(ide_selection|ide_opened_file|ide_diagnostics|system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|command-message|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/g;

/** Turn raw user text into a displayable prompt, or undefined if it is not a real prompt. */
export function cleanPromptText(raw: string): string | undefined {
  let text = raw;
  if (text.trimStart().startsWith('<task-notification>')) return undefined;
  const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
    const name = cmd[1].trim();
    return (name.startsWith('/') ? name : '/' + name) + (args && args[1].trim() ? ' ' + args[1].trim() : '');
  }
  text = text.replace(NOISE_TAG_RE, ' ').trim();
  if (!text) return undefined;
  if (text.startsWith('Caveat: The messages below')) return undefined;
  if (text.startsWith('[Request interrupted')) return undefined;
  return text;
}

interface PendingUsage {
  model?: string;
  usage: TokenUsage;
}

/**
 * Incremental parser for one JSONL transcript. Feed lines with `addLine`, then call `finish`.
 * Malformed lines are counted and skipped.
 */
export class TranscriptAccumulator {
  private readonly stats: TranscriptStats;
  private readonly usageById = new Map<string, PendingUsage>();
  private readonly toolNameById = new Map<string, string>();
  private readonly spawnById = new Map<string, AgentSpawn>();
  private readonly notifications = new Map<string, string>();
  private startMs = Infinity;
  private endMs = -Infinity;
  private lineNo = 0;

  constructor(filePath: string) {
    this.stats = {
      filePath,
      usage: emptyUsage(),
      usageByModel: {},
      models: [],
      apiMessages: 0,
      tools: {},
      mcp: {},
      skills: {},
      toolCalls: 0,
      prompts: [],
      spawns: [],
      lines: 0,
      badLines: 0,
    };
  }

  addLine(line: string): void {
    this.lineNo++;
    const trimmed = line.trim();
    if (!trimmed) return;
    this.stats.lines++;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      this.stats.badLines++;
      return;
    }
    if (!isObj(obj)) {
      this.stats.badLines++;
      return;
    }
    try {
      this.handle(obj);
    } catch {
      // Defensive: unexpected shapes must never abort the whole parse.
      this.stats.badLines++;
    }
  }

  private handle(o: Json): void {
    const ts = str(o.timestamp);
    if (ts) {
      const t = Date.parse(ts);
      if (Number.isFinite(t)) {
        if (t < this.startMs) this.startMs = t;
        if (t > this.endMs) this.endMs = t;
      }
    }
    const s = this.stats;
    s.sessionId ??= str(o.sessionId);
    s.agentId ??= str(o.agentId);
    s.cwd ??= str(o.cwd);
    s.gitBranch = str(o.gitBranch) ?? s.gitBranch;
    s.version = str(o.version) ?? s.version;
    s.entrypoint ??= str(o.entrypoint);

    switch (o.type) {
      case 'ai-title': {
        const t = str(o.aiTitle);
        if (t) s.aiTitle = t;
        break;
      }
      case 'summary': {
        const t = str(o.summary);
        if (t) s.summaryTitle = t;
        break;
      }
      case 'assistant':
        this.handleAssistant(o);
        break;
      case 'user':
        this.handleUser(o, ts);
        break;
      default:
        // attachment, system, last-prompt, queue-operation, file-history-*, unknown: ignored.
        break;
    }
  }

  private handleAssistant(o: Json): void {
    const msg = o.message;
    if (!isObj(msg)) return;
    const model = str(msg.model);
    const u = msg.usage;
    if (isObj(u)) {
      const key = str(msg.id) ?? str(o.uuid) ?? `line:${this.lineNo}`;
      // Same message.id may be split over several lines with identical usage: keep the last.
      this.usageById.set(key, {
        model,
        usage: {
          input: num(u.input_tokens),
          output: num(u.output_tokens),
          cacheWrite: num(u.cache_creation_input_tokens),
          cacheRead: num(u.cache_read_input_tokens),
        },
      });
    }
    const content = msg.content;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!isObj(item) || item.type !== 'tool_use') continue;
      const id = str(item.id);
      const name = str(item.name) ?? '(unknown)';
      if (id) {
        if (this.toolNameById.has(id)) continue; // duplicate block
        this.toolNameById.set(id, name);
      }
      this.recordToolUse(name, isObj(item.input) ? item.input : {}, id, str(o.timestamp));
    }
  }

  private recordToolUse(name: string, input: Json, id: string | undefined, ts: string | undefined): void {
    const s = this.stats;
    s.toolCalls++;
    const mcp = splitMcpName(name);
    if (mcp) {
      const server = (s.mcp[mcp.server] ??= { server: mcp.server, calls: 0, errors: 0, tools: {} });
      server.calls++;
      const tool = (server.tools[mcp.tool] ??= { name: mcp.tool, calls: 0, errors: 0 });
      tool.calls++;
      return;
    }
    const tool = (s.tools[name] ??= { name, calls: 0, errors: 0 });
    tool.calls++;
    if (name === 'Skill') {
      const skill = str(input.skill) ?? '(unknown)';
      s.skills[skill] = (s.skills[skill] ?? 0) + 1;
    }
    const isAgentTool = name === 'Agent' || (name === 'Task' && (str(input.prompt) || str(input.subagent_type)));
    if (AGENT_TOOL_NAMES.has(name) && isAgentTool && id) {
      const spawn: AgentSpawn = {
        toolUseId: id,
        toolName: name,
        timestamp: ts,
        description: str(input.description),
        subagentType: str(input.subagent_type),
        model: str(input.model),
        runInBackground: typeof input.run_in_background === 'boolean' ? input.run_in_background : undefined,
      };
      this.spawnById.set(id, spawn);
      s.spawns.push(spawn);
    }
  }

  private handleUser(o: Json, ts: string | undefined): void {
    const msg = o.message;
    if (!isObj(msg)) return;
    const content = msg.content;
    const texts: string[] = [];
    let hasToolResult = false;
    if (typeof content === 'string') {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (!isObj(item)) continue;
        if (item.type === 'tool_result') {
          hasToolResult = true;
          this.handleToolResult(item, o.toolUseResult);
        } else if (item.type === 'text' && typeof item.text === 'string') {
          texts.push(item.text);
        }
      }
    }
    for (const t of texts) this.scanNotification(t);
    if (hasToolResult || o.isMeta === true || o.isCompactSummary === true || o.isSidechain === true && !this.stats.agentId) {
      return;
    }
    const cleaned = texts.map(cleanPromptText).filter((t): t is string => !!t);
    if (cleaned.length === 0) return;
    const text = cleaned.join(' ');
    this.stats.firstPrompt ??= truncate(text, MAX_PROMPT_CHARS);
    if (this.stats.prompts.length < MAX_PROMPTS) {
      const entry: PromptEntry = { timestamp: ts, text: truncate(text, MAX_PROMPT_CHARS) };
      this.stats.prompts.push(entry);
    }
  }

  private handleToolResult(item: Json, toolUseResult: unknown): void {
    const id = str(item.tool_use_id);
    const isError = item.is_error === true;
    if (isError) {
      const name = (id && this.toolNameById.get(id)) || '(unknown)';
      const mcp = splitMcpName(name);
      const s = this.stats;
      if (mcp) {
        const server = (s.mcp[mcp.server] ??= { server: mcp.server, calls: 0, errors: 0, tools: {} });
        server.errors++;
        (server.tools[mcp.tool] ??= { name: mcp.tool, calls: 0, errors: 0 }).errors++;
      } else {
        (s.tools[name] ??= { name, calls: 0, errors: 0 }).errors++;
      }
    }
    const spawn = id ? this.spawnById.get(id) : undefined;
    if (!spawn) return;
    if (isError) spawn.isError = true;
    if (isObj(toolUseResult)) {
      const r = toolUseResult;
      const result: AgentSpawnResult = {
        agentId: str(r.agentId),
        agentType: str(r.agentType),
        status: str(r.status),
        resolvedModel: str(r.resolvedModel),
        isAsync: typeof r.isAsync === 'boolean' ? r.isAsync : undefined,
        totalTokens: typeof r.totalTokens === 'number' ? r.totalTokens : undefined,
        totalDurationMs: typeof r.totalDurationMs === 'number' ? r.totalDurationMs : undefined,
        totalToolUseCount: typeof r.totalToolUseCount === 'number' ? r.totalToolUseCount : undefined,
      };
      spawn.result = result;
    }
  }

  private scanNotification(text: string): void {
    if (!text.includes('<task-notification>')) return;
    const status = /<status>([^<]*)<\/status>/.exec(text)?.[1]?.trim();
    if (!status) return;
    const toolUseId = /<tool-use-id>([^<]*)<\/tool-use-id>/.exec(text)?.[1]?.trim();
    const taskId = /<task-id>([^<]*)<\/task-id>/.exec(text)?.[1]?.trim();
    if (toolUseId) this.notifications.set(toolUseId, status);
    if (taskId) this.notifications.set(taskId, status);
  }

  finish(): TranscriptStats {
    const s = this.stats;
    for (const { model, usage } of this.usageById.values()) {
      addUsage(s.usage, usage);
      s.apiMessages++;
      const key = model ?? '(unknown)';
      const m = (s.usageByModel[key] ??= { ...emptyUsage(), messages: 0 });
      addUsage(m, usage);
      m.messages++;
    }
    s.models = sortedModels(s.usageByModel);
    for (const spawn of s.spawns) {
      spawn.notifiedStatus =
        this.notifications.get(spawn.toolUseId) ??
        (spawn.result?.agentId ? this.notifications.get(spawn.result.agentId) : undefined);
    }
    if (Number.isFinite(this.startMs)) s.startTime = new Date(this.startMs).toISOString();
    if (Number.isFinite(this.endMs)) s.endTime = new Date(this.endMs).toISOString();
    return s;
  }
}

function sortedModels(byModel: Record<string, ModelUsage>): string[] {
  return Object.entries(byModel)
    .filter(([m]) => m !== '<synthetic>' && m !== '(unknown)')
    .sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]))
    .map(([m]) => m);
}

/** Parse a whole transcript from an in-memory string (used by tests and head peeks). */
export function parseTranscriptText(text: string, filePath = '<memory>'): TranscriptStats {
  const acc = new TranscriptAccumulator(filePath);
  for (const line of text.split('\n')) acc.addLine(line);
  return acc.finish();
}

/** Stream-parse a JSONL transcript file line by line (bounded memory for large files). */
export async function parseTranscriptFile(filePath: string): Promise<TranscriptStats> {
  const acc = new TranscriptAccumulator(filePath);
  await fs.promises.access(filePath, fs.constants.R_OK);
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  // Older Node versions do not forward input stream errors to the readline iterator;
  // close it ourselves so the loop ends, then rethrow.
  let streamError: unknown;
  stream.on('error', (err) => {
    streamError = err;
    rl.close();
  });
  try {
    for await (const line of rl) acc.addLine(line);
  } finally {
    rl.close();
    stream.destroy();
  }
  if (streamError) throw streamError;
  return acc.finish();
}

/**
 * Read at most `maxBytes` from the start of a transcript and parse complete lines only.
 * Cheap way to get cwd / first prompt / early title without reading the whole file.
 */
export async function peekTranscript(filePath: string, maxBytes = 128 * 1024): Promise<TranscriptStats> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    let text = buf.subarray(0, bytesRead).toString('utf8');
    if (bytesRead === maxBytes) {
      const nl = text.lastIndexOf('\n');
      text = nl >= 0 ? text.slice(0, nl) : '';
    }
    return parseTranscriptText(text, filePath);
  } finally {
    await handle.close();
  }
}

interface AgentFile {
  agentId: string;
  jsonlPath: string;
  metaPath: string;
}

async function findAgentFiles(dir: string, depth: number, out: AgentFile[]): Promise<void> {
  if (depth > MAX_SUBAGENT_DIR_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile()) {
      const m = /^agent-(.+)\.jsonl$/.exec(e.name);
      if (m) out.push({ agentId: m[1], jsonlPath: full, metaPath: path.join(dir, `agent-${m[1]}.meta.json`) });
    } else if (e.isDirectory()) {
      await findAgentFiles(full, depth + 1, out);
    }
  }
}

async function readMeta(metaPath: string): Promise<AgentMeta | undefined> {
  try {
    const raw = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
    if (!isObj(raw)) return undefined;
    return {
      agentType: str(raw.agentType),
      description: str(raw.description),
      toolUseId: str(raw.toolUseId),
      spawnDepth: typeof raw.spawnDepth === 'number' ? raw.spawnDepth : undefined,
      requestShape: str(raw.requestShape),
    };
  } catch {
    return undefined;
  }
}

/** Run `fn` over `items` with at most `limit` in flight; preserves order. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function durationOf(stats: TranscriptStats): number | undefined {
  if (!stats.startTime || !stats.endTime) return undefined;
  return Date.parse(stats.endTime) - Date.parse(stats.startTime);
}

function mergeTools(target: Record<string, ToolStat>, src: Record<string, ToolStat>): void {
  for (const t of Object.values(src)) {
    const d = (target[t.name] ??= { name: t.name, calls: 0, errors: 0 });
    d.calls += t.calls;
    d.errors += t.errors;
  }
}

function mergeMcp(target: Record<string, McpServerStat>, src: Record<string, McpServerStat>): void {
  for (const s of Object.values(src)) {
    const d = (target[s.server] ??= { server: s.server, calls: 0, errors: 0, tools: {} });
    d.calls += s.calls;
    d.errors += s.errors;
    mergeTools(d.tools, s.tools);
  }
}

/** Path of the per-session directory holding `subagents/`. */
export function sessionDirFor(sessionPath: string): string {
  return sessionPath.replace(/\.jsonl$/, '');
}

/**
 * Parse a main session transcript plus all subagent transcripts under
 * `<project>/<sessionId>/subagents/`, linking each subagent to the tool_use that spawned it.
 */
export async function parseSession(sessionPath: string): Promise<SessionSummary> {
  const main = await parseTranscriptFile(sessionPath);
  const agentFiles: AgentFile[] = [];
  await findAgentFiles(path.join(sessionDirFor(sessionPath), 'subagents'), 0, agentFiles);

  const parsed = await mapPool(agentFiles, SUBAGENT_PARSE_CONCURRENCY, async (f) => {
    const [stats, meta] = await Promise.all([
      parseTranscriptFile(f.jsonlPath).catch(() => new TranscriptAccumulator(f.jsonlPath).finish()),
      readMeta(f.metaPath),
    ]);
    return { file: f, stats, meta };
  });

  // Index every spawn by tool_use id and by resulting agentId, remembering its owner transcript.
  const ROOT = '\u0000root';
  const byToolUse = new Map<string, { owner: string; spawn: AgentSpawn }>();
  const byAgentId = new Map<string, { owner: string; spawn: AgentSpawn }>();
  const index = (owner: string, stats: TranscriptStats) => {
    for (const spawn of stats.spawns) {
      byToolUse.set(spawn.toolUseId, { owner, spawn });
      if (spawn.result?.agentId) byAgentId.set(spawn.result.agentId, { owner, spawn });
    }
  };
  index(ROOT, main);
  for (const p of parsed) index(p.file.agentId, p.stats);

  const nodes = new Map<string, SubagentNode>();
  const linkedSpawn = new Set<string>();
  const parentOf = new Map<string, string>();
  for (const p of parsed) {
    const link =
      (p.meta?.toolUseId ? byToolUse.get(p.meta.toolUseId) : undefined) ?? byAgentId.get(p.file.agentId);
    const spawn = link?.spawn;
    const owner = link && link.owner !== p.file.agentId ? link.owner : ROOT;
    parentOf.set(p.file.agentId, owner);
    const status = spawn?.isError
      ? 'error'
      : spawn?.notifiedStatus ?? (spawn?.result?.status === 'async_launched' ? 'launched' : spawn?.result?.status);
    if (spawn) linkedSpawn.add(spawn.toolUseId);
    nodes.set(p.file.agentId, {
      agentId: p.file.agentId,
      transcriptPath: p.file.jsonlPath,
      meta: p.meta,
      spawn,
      agentType: p.meta?.agentType ?? spawn?.subagentType ?? spawn?.result?.agentType ?? 'agent',
      description: p.meta?.description ?? spawn?.description ?? truncate(p.stats.firstPrompt ?? '', 80),
      model: p.stats.models[0] ?? spawn?.result?.resolvedModel ?? spawn?.model,
      status,
      durationMs: durationOf(p.stats) ?? spawn?.result?.totalDurationMs,
      depth: 1,
      stats: p.stats,
      children: [],
      totalUsage: emptyUsage(),
    });
  }

  // Spawns without a transcript file (older versions, or file not yet written): keep them visible
  // using the numbers reported in toolUseResult, but they contribute no tokens to the totals.
  for (const [toolUseId, { owner, spawn }] of byToolUse) {
    if (linkedSpawn.has(toolUseId)) continue;
    const id = spawn.result?.agentId ?? toolUseId;
    if (nodes.has(id)) continue;
    parentOf.set(id, owner);
    nodes.set(id, {
      agentId: id,
      transcriptPath: '',
      spawn,
      agentType: spawn.subagentType ?? spawn.result?.agentType ?? 'agent',
      description: spawn.description ?? '',
      model: spawn.result?.resolvedModel ?? spawn.model,
      status: spawn.isError ? 'error' : spawn.notifiedStatus ?? spawn.result?.status,
      durationMs: spawn.result?.totalDurationMs,
      reportedTokens: spawn.result?.totalTokens,
      depth: 1,
      stats: new TranscriptAccumulator('').finish(),
      children: [],
      totalUsage: emptyUsage(),
    });
  }

  // Break any cycles (malformed data) by re-attaching to the root.
  for (const id of nodes.keys()) {
    const seen = new Set<string>([id]);
    let cur = parentOf.get(id);
    while (cur && cur !== ROOT) {
      if (seen.has(cur) || !nodes.has(cur)) {
        parentOf.set(id, ROOT);
        break;
      }
      seen.add(cur);
      cur = parentOf.get(cur);
    }
  }

  const roots: SubagentNode[] = [];
  for (const node of nodes.values()) {
    const parent = parentOf.get(node.agentId);
    if (parent && parent !== ROOT) nodes.get(parent)!.children.push(node);
    else roots.push(node);
  }
  const byStart = (a: SubagentNode, b: SubagentNode) =>
    (a.stats.startTime ?? '').localeCompare(b.stats.startTime ?? '');
  const finalize = (list: SubagentNode[], depth: number): TokenUsage => {
    list.sort(byStart);
    const sum = emptyUsage();
    for (const n of list) {
      n.depth = depth;
      n.totalUsage = { ...n.stats.usage };
      addUsage(n.totalUsage, finalize(n.children, depth + 1));
      addUsage(sum, n.totalUsage);
    }
    return sum;
  };
  finalize(roots, 1);

  // Totals: main + each agent exactly once (flat iteration avoids double counting).
  const all = [main, ...parsed.map((p) => p.stats)];
  const totalUsage = emptyUsage();
  const totalByModel: Record<string, ModelUsage> = {};
  const totalTools: Record<string, ToolStat> = {};
  const totalMcp: Record<string, McpServerStat> = {};
  const totalSkills: Record<string, number> = {};
  let totalToolCalls = 0;
  for (const st of all) {
    addUsage(totalUsage, st.usage);
    for (const [model, mu] of Object.entries(st.usageByModel)) {
      const d = (totalByModel[model] ??= { ...emptyUsage(), messages: 0 });
      addUsage(d, mu);
      d.messages += mu.messages;
    }
    mergeTools(totalTools, st.tools);
    mergeMcp(totalMcp, st.mcp);
    for (const [k, v] of Object.entries(st.skills)) totalSkills[k] = (totalSkills[k] ?? 0) + v;
    totalToolCalls += st.toolCalls;
  }

  const sessionId = main.sessionId ?? path.basename(sessionPath, '.jsonl');
  return {
    filePath: sessionPath,
    sessionId,
    title: sessionTitle(main, sessionId),
    main,
    subagents: roots,
    agentCount: nodes.size,
    durationMs: durationOf(main),
    totalUsage,
    totalByModel,
    totalTools,
    totalMcp,
    totalSkills,
    totalToolCalls,
    models: sortedModels(totalByModel),
  };
}

export function sessionTitle(stats: TranscriptStats, fallback: string): string {
  return stats.aiTitle ?? stats.summaryTitle ?? (stats.firstPrompt ? truncate(stats.firstPrompt, 80) : fallback);
}
