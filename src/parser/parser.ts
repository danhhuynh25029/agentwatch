import * as fs from 'fs';
import * as path from 'path';
import { addUsage, emptyUsage, totalTokens, truncate } from './format';
import {
  AgentMeta,
  AgentSpawn,
  AgentSpawnResult,
  CommitEntry,
  ContextPoint,
  FileEditStat,
  FileReadStat,
  LargeResult,
  McpServerStat,
  ModelUsage,
  PromptEntry,
  SessionSummary,
  SubagentNode,
  TokenUsage,
  ToolErrorEntry,
  ToolResultSize,
  ToolStat,
  TranscriptStats,
} from './types';

/** Tool names that spawn a subagent ("Task" in older Claude Code versions). */
const AGENT_TOOL_NAMES = new Set(['Agent', 'Task']);
const MAX_PROMPTS = 500;
const MAX_PROMPT_CHARS = 300;
const MAX_SUBAGENT_DIR_DEPTH = 4;
const SUBAGENT_PARSE_CONCURRENCY = 4;
const MAX_TOOL_ERRORS = 200;
const MAX_SESSION_TOOL_ERRORS = 500;
const MAX_ERROR_CHARS = 500;
const MAX_INPUT_PREVIEW_CHARS = 300;
const MAX_FILE_EDITS = 2000;
const MAX_CONTEXT_POINTS = 300;
const MAX_COMPACTIONS = 200;
const MAX_PENDING_TOOLS = 5;
const MAX_LARGE_RESULTS = 20;
const MAX_FILE_READS = 2000;
const MAX_COMMITS = 200;
/** `git commit` as a command (start of the line or after a shell operator), not inside other text. */
// Option values exclude shell operators so a match cannot span separators (avoids quadratic backtracking).
const GIT_COMMIT_RE = /(?:^|&&|\|\||[;\n(|])\s*git\s+(?:-[Cc]\s+[^\s;&|()]+\s+)*commit\b/;
const MAX_COMMIT_COMMAND_CHARS = 8192;

/** True if a Bash command runs `git commit` (heredoc bodies are ignored). */
export function isGitCommitCommand(command: string): boolean {
  const heredoc = command.indexOf('<<');
  const head = heredoc >= 0 ? command.slice(0, heredoc) : command;
  return GIT_COMMIT_RE.test(head.slice(0, MAX_COMMIT_COMMAND_CHARS));
}
const COMMIT_OUTPUT_RE = /^\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.*)$/m;
/** Tools that modify files; the path is in input.file_path (or notebook_path). */
export const FILE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Size limits for untrusted on-disk input. Overridable in tests. */
export interface ParseLimits {
  /** Transcript files larger than this are not parsed (flagged via `TranscriptStats.skipped`). */
  maxTranscriptBytes: number;
  /**
   * Single JSONL lines longer than this many bytes are counted as bad lines; their bytes are
   * discarded while streaming, so the oversized string is never built.
   */
  maxLineBytes: number;
  /** meta.json files larger than this are ignored. */
  maxMetaBytes: number;
  /** At most this many subagent transcripts are parsed per session (the rest are counted as skipped). */
  maxSubagentFiles: number;
  /** At most this many spawn-only subagent nodes (no transcript file) are kept per session. */
  maxSpawnNodes: number;
}

/** Options for {@link parseTranscriptFile}. `highWaterMark` (read chunk size) exists for tests. */
export type TranscriptReadLimits = Pick<ParseLimits, 'maxTranscriptBytes' | 'maxLineBytes'> & { highWaterMark?: number };

export const DEFAULT_LIMITS: Readonly<ParseLimits> = Object.freeze({
  maxTranscriptBytes: 512 * 1024 * 1024,
  maxLineBytes: 16 * 1024 * 1024,
  maxMetaBytes: 1024 * 1024,
  maxSubagentFiles: 2000,
  maxSpawnNodes: 5000,
});

/**
 * Prototype-less map for keys taken from transcripts (model / tool / server / skill names).
 * A plain `{}` would let a key like "__proto__" mutate Object.prototype via `obj[key] ??= ...`.
 */
function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

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

const NOISE_TAGS = [
  'ide_selection',
  'ide_opened_file',
  'ide_diagnostics',
  'system-reminder',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'command-message',
  'user-prompt-submit-hook',
];

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_]/.test(c);
}

/**
 * Replace every `<tag ...>...</tag>` block of a noise tag with a space. Same result as
 * `/<(tag1|tag2|...)\b[^>]*>[\s\S]*?<\/\1>/g`, but linear time: the regex rescans to the end of
 * the input for every unclosed opening tag, which is quadratic on crafted transcripts.
 * Positions found by indexOf are cached and reused because the scan only moves forward.
 */
export function stripNoiseTags(text: string): string {
  let out = '';
  let copyFrom = 0;
  let i = text.indexOf('<');
  let nextGt = -2; // cached index of the next '>' at or after the scan position (-1 = none left)
  const closeAt = new Map<string, number>(); // tag -> cached index of next closing tag (-1 = none left)
  while (i >= 0) {
    let matchedEnd = -1;
    for (const tag of NOISE_TAGS) {
      if (!text.startsWith(tag, i + 1) || isWordChar(text[i + 1 + tag.length])) continue;
      const nameEnd = i + 1 + tag.length;
      if (nextGt !== -1 && nextGt < nameEnd) nextGt = text.indexOf('>', nameEnd);
      if (nextGt === -1) break; // no '>' anywhere after this point: nothing more can match
      const closeTag = `</${tag}>`;
      let close = closeAt.get(tag);
      if (close === undefined || (close !== -1 && close < nextGt + 1)) {
        close = text.indexOf(closeTag, nextGt + 1);
        closeAt.set(tag, close);
      }
      if (close === -1) continue; // never closed after here
      matchedEnd = close + closeTag.length;
      break;
    }
    if (matchedEnd >= 0) {
      out += text.slice(copyFrom, i) + ' ';
      copyFrom = matchedEnd;
      i = text.indexOf('<', matchedEnd);
    } else {
      i = text.indexOf('<', i + 1);
    }
  }
  return copyFrom === 0 ? text : out + text.slice(copyFrom);
}

/** Inner text of the first `<tag>...</tag>` (linear; equivalent to a lazy non-global regex exec). */
function firstTagContent(text: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const start = text.indexOf(open);
  if (start < 0) return undefined;
  const end = text.indexOf(`</${tag}>`, start + open.length);
  return end < 0 ? undefined : text.slice(start + open.length, end);
}

/** Turn raw user text into a displayable prompt, or undefined if it is not a real prompt. */
export function cleanPromptText(raw: string): string | undefined {
  let text = raw;
  if (text.trimStart().startsWith('<task-notification>')) return undefined;
  const cmd = firstTagContent(text, 'command-name');
  if (cmd !== undefined) {
    const args = firstTagContent(text, 'command-args')?.trim();
    const name = cmd.trim();
    return (name.startsWith('/') ? name : '/' + name) + (args ? ' ' + args : '');
  }
  text = stripNoiseTags(text).trim();
  if (!text) return undefined;
  if (text.startsWith('Caveat: The messages below')) return undefined;
  if (text.startsWith('[Request interrupted')) return undefined;
  return text;
}

interface PendingUsage {
  model?: string;
  usage: TokenUsage;
  /** Epoch ms of the first line carrying this message (or the latest timestamp seen before it). */
  t?: number;
}

/** UTC hour of an epoch-ms time as YYYY-MM-DDTHH. */
export function utcHour(t: number): string {
  return new Date(t).toISOString().slice(0, 13);
}

/** Parse `[branch abc1234] message` from git commit output. */
export function parseCommitOutput(text: string): { branch: string; hash: string; message: string } | undefined {
  const m = COMMIT_OUTPUT_RE.exec(text);
  return m ? { branch: m[1], hash: m[2], message: m[3].trim() } : undefined;
}

/** Local calendar day of an epoch-ms time as YYYY-MM-DD. */
export function localDay(t: number): string {
  const d = new Date(t);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Text content of a tool_result block (string or list of text blocks). */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content) {
    if (isObj(c) && c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
  }
  return parts.join('\n');
}

/** JSON of a tool input, cut to `max` chars (never throws). */
export function previewJson(v: unknown, max: number): string {
  let text: string;
  try {
    text = JSON.stringify(v) ?? '';
  } catch {
    text = '';
  }
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/** Keep at most `max` points, preserving the first and last and the peak of each bucket. */
export function downsample(points: ContextPoint[], max: number): ContextPoint[] {
  if (points.length <= max) return points;
  const out: ContextPoint[] = [];
  const size = points.length / max;
  for (let b = 0; b < max; b++) {
    const from = Math.floor(b * size);
    const to = Math.min(points.length, Math.floor((b + 1) * size));
    let best = points[from];
    for (let i = from + 1; i < to; i++) if (points[i].tokens > best.tokens) best = points[i];
    out.push(best);
  }
  out[0] = points[0];
  out[out.length - 1] = points[points.length - 1];
  return out;
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
  /** Truncated input JSON per tool_use id, for error reports. */
  private readonly inputById = new Map<string, string>();
  /** File path per Edit/Write tool_use id. */
  private readonly editPathById = new Map<string, string>();
  /** tool_use ids still waiting for a tool_result (insertion order = call order). */
  private readonly openTools = new Map<string, string>();
  private readonly compactionIdx: ContextPoint[] = [];
  private lastMs: number | undefined;
  private fileEditCount = 0;
  /** True between a prompt and the end of its turn (so a turn end is recorded once). */
  private turnOpen = true;
  private fileReadCount = 0;
  /** Read tool_use id -> file path. */
  private readonly readPathById = new Map<string, string>();
  /** Bash tool_use id -> pending git commit entry. */
  private readonly commitById = new Map<string, CommitEntry>();
  private startMs = Infinity;
  private endMs = -Infinity;
  private lineNo = 0;

  constructor(filePath: string) {
    this.stats = {
      filePath,
      usage: emptyUsage(),
      usageByModel: dict(),
      models: [],
      apiMessages: 0,
      tools: dict(),
      mcp: dict(),
      skills: dict(),
      toolCalls: 0,
      prompts: [],
      spawns: [],
      toolErrors: [],
      fileEdits: dict(),
      context: [],
      compactions: [],
      usageByDay: dict(),
      pendingTools: [],
      usageByHour: dict(),
      resultSizes: dict(),
      largestResults: [],
      fileReads: dict(),
      commits: [],
      lines: 0,
      badLines: 0,
    };
  }

  /** Record a line that was dropped without parsing (over the line size limit). */
  addOversizedLine(): void {
    this.lineNo++;
    this.stats.lines++;
    this.stats.badLines++;
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
        this.lastMs = t;
      }
    }
    if (o.isCompactSummary === true || (o.type === 'system' && o.subtype === 'compact_boundary')) {
      this.recordCompaction(ts);
    }
    const s = this.stats;
    s.sessionId ??= str(o.sessionId);
    s.agentId ??= str(o.agentId);
    s.cwd ??= str(o.cwd);
    s.gitBranch = str(o.gitBranch) ?? s.gitBranch;
    s.version = str(o.version) ?? s.version;
    s.entrypoint ??= str(o.entrypoint);

    // A Stop hook summary also marks the end of a turn, but only count each turn once.
    if (o.type === 'system' && o.subtype === 'stop_hook_summary' && ts && this.turnOpen) {
      s.turnEndedAt = ts;
      this.turnOpen = false;
    }
    switch (o.type) {
      case 'cost-state': {
        if (typeof o.totalCostUSD === 'number' && Number.isFinite(o.totalCostUSD) && o.totalCostUSD >= 0) {
          s.reportedCostUsd = o.totalCostUSD;
        }
        break;
      }
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
    const stop = str(msg.stop_reason);
    if (stop) {
      this.stats.lastStopReason = stop;
      if (stop === 'end_turn' && this.turnOpen) {
        this.stats.turnEndedAt = str(o.timestamp) ?? this.stats.turnEndedAt;
        this.turnOpen = false;
      }
      if (stop === 'end_turn') {
        // The turn is over: any call still without a result was abandoned.
        this.openTools.clear();
      }
    }
    const u = msg.usage;
    if (isObj(u)) {
      const cw1h = isObj(u.cache_creation) ? num(u.cache_creation.ephemeral_1h_input_tokens) : 0;
      const key = str(msg.id) ?? str(o.uuid) ?? `line:${this.lineNo}`;
      // Same message.id may be split over several lines with identical usage: keep the last
      // usage, but the first time (Map keeps the first insertion position).
      this.usageById.set(key, {
        t: this.usageById.get(key)?.t ?? this.lastMs,
        model,
        usage: {
          input: num(u.input_tokens),
          output: num(u.output_tokens),
          cacheWrite: num(u.cache_creation_input_tokens),
          cacheRead: num(u.cache_read_input_tokens),
          ...(cw1h ? { cacheWrite1h: Math.min(cw1h, num(u.cache_creation_input_tokens)) } : {}),
        },
      });
    }
    const content = msg.content;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!isObj(item) || item.type !== 'tool_use') continue;
      const id = str(item.id);
      const name = str(item.name) ?? '(unknown)';
      const input = isObj(item.input) ? item.input : {};
      if (id) {
        if (this.toolNameById.has(id)) continue; // duplicate block
        this.toolNameById.set(id, name);
        this.inputById.set(id, previewJson(input, MAX_INPUT_PREVIEW_CHARS));
        this.openTools.set(id, name);
      }
      this.recordToolUse(name, input, id, str(o.timestamp));
    }
  }

  private recordToolUse(name: string, input: Json, id: string | undefined, ts: string | undefined): void {
    const s = this.stats;
    s.toolCalls++;
    const mcp = splitMcpName(name);
    if (mcp) {
      const server = (s.mcp[mcp.server] ??= { server: mcp.server, calls: 0, errors: 0, tools: dict() });
      server.calls++;
      const tool = (server.tools[mcp.tool] ??= { name: mcp.tool, calls: 0, errors: 0 });
      tool.calls++;
      return;
    }
    const tool = (s.tools[name] ??= { name, calls: 0, errors: 0 });
    tool.calls++;
    if (FILE_EDIT_TOOLS.has(name)) this.recordFileEdit(name, input, id, ts);
    if (name === 'Read' && id) {
      const file = str(input.file_path);
      if (file) this.readPathById.set(id, file);
    }
    if (name === 'Bash' && id && typeof input.command === 'string' && isGitCommitCommand(input.command)) {
      if (s.commits.length < MAX_COMMITS) {
        const entry: CommitEntry = { timestamp: ts, command: truncate(input.command, 200), usageAtCommit: this.usageSnapshot() };
        s.commits.push(entry);
        this.commitById.set(id, entry);
      }
    }
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

  private recordFileEdit(name: string, input: Json, id: string | undefined, ts: string | undefined): void {
    const file = str(input.file_path) ?? str(input.notebook_path);
    if (!file) return;
    const edits = this.stats.fileEdits;
    let stat = edits[file];
    if (!stat) {
      if (this.fileEditCount >= MAX_FILE_EDITS) return;
      this.fileEditCount++;
      stat = edits[file] = { path: file, edits: 0, writes: 0, failed: 0 };
    }
    if (name === 'Write') stat.writes++;
    else stat.edits++;
    if (ts) stat.lastTime = ts;
    if (id) this.editPathById.set(id, file);
  }

  /** Cumulative usage per model so far (deduped messages). */
  private usageSnapshot(): Record<string, TokenUsage> {
    const out = dict<TokenUsage>();
    for (const { model, usage } of this.usageById.values()) addUsage((out[model ?? '(unknown)'] ??= emptyUsage()), usage);
    return out;
  }

  private recordResultSize(item: Json, id: string | undefined): void {
    const name = (id && this.toolNameById.get(id)) || '(unknown)';
    const text = toolResultText(item.content);
    const chars = text.length;
    const s = this.stats;
    const size: ToolResultSize = (s.resultSizes[name] ??= { name, calls: 0, chars: 0 });
    size.calls++;
    size.chars += chars;
    const list = s.largestResults;
    if (chars > 0 && (list.length < MAX_LARGE_RESULTS || chars > list[list.length - 1].chars)) {
      const entry: LargeResult = {
        tool: name,
        input: (id && this.inputById.get(id)) || '',
        chars,
        timestamp: this.lastMs !== undefined ? new Date(this.lastMs).toISOString() : undefined,
      };
      let at = list.findIndex((e) => e.chars < chars);
      if (at < 0) at = list.length;
      list.splice(at, 0, entry);
      if (list.length > MAX_LARGE_RESULTS) list.pop();
    }
    const readPath = id ? this.readPathById.get(id) : undefined;
    if (readPath) {
      let r: FileReadStat | undefined = s.fileReads[readPath];
      if (!r && this.fileReadCount < MAX_FILE_READS) {
        this.fileReadCount++;
        r = s.fileReads[readPath] = { path: readPath, reads: 0, chars: 0 };
      }
      if (r) {
        r.reads++;
        r.chars += chars;
      }
    }
    const commit = id ? this.commitById.get(id) : undefined;
    if (commit) {
      const parsed = parseCommitOutput(text);
      if (parsed) Object.assign(commit, parsed);
      // `git commit -q` prints nothing: only an error result counts as a failure.
      if (item.is_error === true) commit.failed = true;
    }
  }

  private recordCompaction(ts: string | undefined): void {
    if (this.compactionIdx.length >= MAX_COMPACTIONS) return;
    const i = this.usageById.size;
    const last = this.compactionIdx[this.compactionIdx.length - 1];
    // A compact_boundary line is usually followed by the isCompactSummary user line: count once.
    if (last && last.i === i) return;
    this.compactionIdx.push({ i, timestamp: ts, tokens: 0 });
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
    // An interrupt or a new prompt means earlier calls without a result will never get one.
    if (texts.some((t) => t.trimStart().startsWith('[Request interrupted'))) this.openTools.clear();
    // Any user line other than a tool result (a prompt, a background task notification) starts a turn.
    if (!hasToolResult && o.isSidechain !== true && texts.length) this.turnOpen = true;
    if (hasToolResult || o.isMeta === true || o.isCompactSummary === true || o.isSidechain === true && !this.stats.agentId) {
      return;
    }
    const cleaned = texts.map(cleanPromptText).filter((t): t is string => !!t);
    if (cleaned.length === 0) return;
    const text = cleaned.join(' ');
    if (o.isSidechain !== true) this.openTools.clear();
    if (!this.stats.firstPrompt) this.stats.firstPrompt = truncate(text, MAX_PROMPT_CHARS);
    if (this.stats.prompts.length < MAX_PROMPTS) {
      const entry: PromptEntry = { timestamp: ts, text: truncate(text, MAX_PROMPT_CHARS) };
      this.stats.prompts.push(entry);
    }
  }

  private handleToolResult(item: Json, toolUseResult: unknown): void {
    const id = str(item.tool_use_id);
    const isError = item.is_error === true;
    if (id) this.openTools.delete(id);
    if (isError) {
      const name = (id && this.toolNameById.get(id)) || '(unknown)';
      const mcp = splitMcpName(name);
      const s = this.stats;
      if (s.toolErrors.length < MAX_TOOL_ERRORS) {
        s.toolErrors.push({
          timestamp: this.lastMs !== undefined ? new Date(this.lastMs).toISOString() : undefined,
          tool: name,
          input: (id && this.inputById.get(id)) || '',
          error: truncate(toolResultText(item.content), MAX_ERROR_CHARS),
        });
      }
      const editPath = id ? this.editPathById.get(id) : undefined;
      if (editPath && s.fileEdits[editPath]) s.fileEdits[editPath].failed++;
      if (mcp) {
        const server = (s.mcp[mcp.server] ??= { server: mcp.server, calls: 0, errors: 0, tools: dict() });
        server.errors++;
        (server.tools[mcp.tool] ??= { name: mcp.tool, calls: 0, errors: 0 }).errors++;
      } else {
        (s.tools[name] ??= { name, calls: 0, errors: 0 }).errors++;
      }
    }
    this.recordResultSize(item, id);
    if (id) {
      // Only needed until the result arrives.
      this.inputById.delete(id);
      this.editPathById.delete(id);
      this.readPathById.delete(id);
      this.commitById.delete(id);
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

  /**
   * Compute derived totals. Idempotent: lines can still be added afterwards and `finish` called
   * again (incremental parsing of a growing transcript). Returns the same stats object each time.
   */
  finish(): TranscriptStats {
    const s = this.stats;
    s.usage = emptyUsage();
    s.usageByModel = dict();
    s.usageByDay = dict();
    s.usageByHour = dict();
    s.apiMessages = 0;
    const context: ContextPoint[] = [];
    // Messages seen before any timestamp are attributed to the transcript's first timestamp.
    const fallbackMs = Number.isFinite(this.startMs) ? this.startMs : undefined;
    for (const { model, usage, t: seenAt } of this.usageById.values()) {
      const t = seenAt ?? fallbackMs;
      addUsage(s.usage, usage);
      const key = model ?? '(unknown)';
      const m = (s.usageByModel[key] ??= { ...emptyUsage(), messages: 0 });
      addUsage(m, usage);
      m.messages++;
      if (t !== undefined) {
        const hour = (s.usageByHour[utcHour(t)] ??= dict());
        const hm = (hour[key] ??= { ...emptyUsage(), messages: 0 });
        addUsage(hm, usage);
        hm.messages++;
        const day = (s.usageByDay[localDay(t)] ??= dict());
        const dm = (day[key] ??= { ...emptyUsage(), messages: 0 });
        addUsage(dm, usage);
        dm.messages++;
      }
      if (key !== '<synthetic>') {
        context.push({
          i: s.apiMessages,
          timestamp: t !== undefined ? new Date(t).toISOString() : undefined,
          tokens: usage.input + usage.cacheWrite + usage.cacheRead,
        });
      }
      s.apiMessages++;
    }
    s.context = downsample(context, MAX_CONTEXT_POINTS);
    s.compactions = [...this.compactionIdx];
    s.pendingTools = [...this.openTools.values()].slice(-MAX_PENDING_TOOLS);
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

/**
 * Stream-parse a JSONL transcript file line by line (bounded memory for large files).
 * Files over `limits.maxTranscriptBytes` are not parsed: the result is empty with `skipped` set.
 */
export async function parseTranscriptFile(
  filePath: string,
  limits: TranscriptReadLimits = DEFAULT_LIMITS,
): Promise<TranscriptStats> {
  const acc = new TranscriptAccumulator(filePath);
  await fs.promises.access(filePath, fs.constants.R_OK);
  const { size } = await fs.promises.stat(filePath);
  if (size > limits.maxTranscriptBytes) {
    const stats = acc.finish();
    stats.skipped = `file too large (${formatMiB(size)} > ${formatMiB(limits.maxTranscriptBytes)}), not parsed`;
    return stats;
  }
  // `end` bounds the read even if the file grows (live session) between stat and read.
  // No `encoding`: lines are split on raw 0x0A bytes and decoded whole, so multi-byte UTF-8
  // characters split across chunks decode correctly.
  const stream = fs.createReadStream(filePath, {
    end: limits.maxTranscriptBytes - 1,
    highWaterMark: limits.highWaterMark,
  });
  try {
    await forEachLine(stream, limits.maxLineBytes, (line) => acc.addLine(line), () => acc.addOversizedLine());
  } finally {
    stream.destroy();
  }
  return acc.finish();
}

/**
 * Split a byte stream into '\n'-terminated lines (a trailing '\r' is left for the caller to trim).
 * Unlike readline, a line longer than `maxLineBytes` is never buffered: once it exceeds the limit
 * its bytes are discarded up to the next '\n' and `onOversized` is called instead of `onLine`.
 * Stream errors reject the returned promise.
 */
export async function forEachLine(
  stream: AsyncIterable<Buffer | string>,
  maxLineBytes: number,
  onLine: (line: string) => void,
  onOversized: () => void,
  opts: { completeLinesOnly?: boolean } = {},
): Promise<number> {
  /** Bytes up to and including the last '\n' handed to onLine/onOversized. */
  let consumed = 0;
  let pos = 0;
  let parts: Buffer[] = [];
  let len = 0;
  let dropping = false;
  let pending = false; // bytes (or a dropped line) seen since the last '\n'
  const emit = () => {
    if (dropping) onOversized();
    else onLine(parts.length === 1 ? parts[0].toString('utf8') : Buffer.concat(parts, len).toString('utf8'));
    parts = [];
    len = 0;
    dropping = false;
    pending = false;
  };
  for await (const raw of stream) {
    const chunk = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
    let start = 0;
    while (start <= chunk.length) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl === -1 ? chunk.length : nl;
      const piece = end - start;
      if (piece > 0) pending = true;
      if (!dropping && piece > 0) {
        if (len + piece > maxLineBytes) {
          dropping = true;
          parts = [];
          len = 0;
        } else {
          // Copy so a short line does not pin the whole read chunk in memory.
          parts.push(Buffer.from(chunk.subarray(start, end)));
          len += piece;
        }
      }
      if (nl === -1) break;
      emit();
      start = nl + 1;
      consumed = pos + start;
    }
    pos += chunk.length;
  }
  // A line without '\n' may still be being written (live transcript): leave it for the next read.
  if (pending && !opts.completeLinesOnly) {
    emit();
    consumed = pos;
  }
  return consumed;
}

const HEAD_BYTES = 256;

/** Deep copy of plain data, keeping prototype-less maps prototype-less. */
function cloneData<T>(v: T): T {
  if (Array.isArray(v)) return v.map(cloneData) as unknown as T;
  if (typeof v !== 'object' || v === null) return v;
  const out: Record<string, unknown> = Object.getPrototypeOf(v) === null ? Object.create(null) : {};
  for (const k of Object.keys(v)) out[k] = cloneData((v as Record<string, unknown>)[k]);
  return out as T;
}

/**
 * Independent copy of incrementally parsed stats: later updates mutate the parser's own object,
 * so each summary must hold a snapshot.
 */
export function snapshotStats(s: TranscriptStats): TranscriptStats {
  return cloneData(s);
}

async function readHeadBytes(filePath: string, n: number): Promise<Buffer> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await handle.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Parses a transcript that keeps growing (a running session): each `update` reads only the bytes
 * appended since the previous one. A trailing line without '\n' is left for the next read. If the
 * file shrank or its first bytes changed (rewritten), it is parsed again from scratch.
 */
export class IncrementalTranscript {
  private acc: TranscriptAccumulator;
  private offset = 0;
  private head: Buffer | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly limits: TranscriptReadLimits = DEFAULT_LIMITS,
  ) {
    this.acc = new TranscriptAccumulator(filePath);
  }

  /** Bytes consumed so far (for tests). */
  get bytesRead(): number {
    return this.offset;
  }

  update(): Promise<TranscriptStats> {
    // Serialise updates: two reads interleaving would feed lines twice or out of order.
    const run = this.queue.then(() => this.doUpdate());
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doUpdate(): Promise<TranscriptStats> {
    const { size } = await fs.promises.stat(this.filePath);
    if (size > this.limits.maxTranscriptBytes) return parseTranscriptFile(this.filePath, this.limits);
    const head = await readHeadBytes(this.filePath, HEAD_BYTES);
    const same = !this.head || head.subarray(0, this.head.length).equals(this.head.subarray(0, Math.min(this.head.length, head.length)));
    if (size < this.offset || !same) {
      this.acc = new TranscriptAccumulator(this.filePath);
      this.offset = 0;
    }
    if (!this.head || this.head.length < HEAD_BYTES) this.head = head;
    if (size > this.offset) {
      const stream = fs.createReadStream(this.filePath, { start: this.offset, end: size - 1, highWaterMark: this.limits.highWaterMark });
      try {
        this.offset += await forEachLine(stream, this.limits.maxLineBytes, (l) => this.acc.addLine(l), () => this.acc.addOversizedLine(), {
          completeLinesOnly: true,
        });
      } finally {
        stream.destroy();
      }
    }
    return this.acc.finish();
  }
}

function formatMiB(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
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

interface AgentFileScan {
  files: AgentFile[];
  /** Agent transcripts found beyond `max` (not parsed). */
  skipped: number;
  max: number;
}

async function findAgentFiles(dir: string, depth: number, out: AgentFileScan): Promise<void> {
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
      if (!m) continue;
      if (out.files.length >= out.max) out.skipped++;
      else out.files.push({ agentId: m[1], jsonlPath: full, metaPath: path.join(dir, `agent-${m[1]}.meta.json`) });
    } else if (e.isDirectory()) {
      await findAgentFiles(full, depth + 1, out);
    }
  }
}

/** Read a whole file only if it is at most `maxBytes` (never buffers more than maxBytes + 1). */
async function readSmallFile(filePath: string, maxBytes: number): Promise<string | undefined> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size > maxBytes) return undefined;
    // +1 detects growth past the cap after stat.
    const buf = Buffer.alloc(size + 1);
    let total = 0;
    while (total < buf.length) {
      const { bytesRead } = await handle.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) return undefined;
    return buf.subarray(0, total).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readMeta(metaPath: string, maxBytes: number): Promise<AgentMeta | undefined> {
  try {
    const text = await readSmallFile(metaPath, maxBytes);
    if (text === undefined) return undefined;
    const raw = JSON.parse(text);
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
    const d = (target[s.server] ??= { server: s.server, calls: 0, errors: 0, tools: dict() });
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
export async function parseSession(
  sessionPath: string,
  limits: ParseLimits = DEFAULT_LIMITS,
  /** How each transcript (main and subagents) is parsed; the store passes an incremental parser for live files. */
  parseFile: (filePath: string) => Promise<TranscriptStats> = (f) => parseTranscriptFile(f, limits),
): Promise<SessionSummary> {
  const main = await parseFile(sessionPath);
  const scan: AgentFileScan = { files: [], skipped: 0, max: limits.maxSubagentFiles };
  await findAgentFiles(path.join(sessionDirFor(sessionPath), 'subagents'), 0, scan);
  const agentFiles = scan.files;

  const parsed = await mapPool(agentFiles, SUBAGENT_PARSE_CONCURRENCY, async (f) => {
    const [stats, meta] = await Promise.all([
      parseFile(f.jsonlPath).catch(() => new TranscriptAccumulator(f.jsonlPath).finish()),
      readMeta(f.metaPath, limits.maxMetaBytes),
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
  // Capped: a crafted transcript can contain any number of spawn tool_use blocks.
  let spawnNodes = 0;
  let spawnNodesSkipped = 0;
  for (const [toolUseId, { owner, spawn }] of byToolUse) {
    if (linkedSpawn.has(toolUseId)) continue;
    const id = spawn.result?.agentId ?? toolUseId;
    if (nodes.has(id)) continue;
    if (spawnNodes >= limits.maxSpawnNodes) {
      spawnNodesSkipped++;
      continue;
    }
    spawnNodes++;
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
  // Iterative (not recursive) so a long crafted parent chain cannot overflow the stack.
  // BFS sets depth and sort order; parents precede children in `order`, so walking it
  // backwards sums children into parents bottom-up.
  roots.sort(byStart);
  const order: SubagentNode[] = [];
  for (const r of roots) r.depth = 1;
  const queue = [...roots];
  for (let qi = 0; qi < queue.length; qi++) {
    const n = queue[qi];
    order.push(n);
    n.children.sort(byStart);
    for (const c of n.children) {
      c.depth = n.depth + 1;
      queue.push(c);
    }
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    n.totalUsage = { ...n.stats.usage };
    for (const c of n.children) addUsage(n.totalUsage, c.totalUsage);
  }

  // Totals: main + each agent exactly once (flat iteration avoids double counting).
  const all = [main, ...parsed.map((p) => p.stats)];
  const totalUsage = emptyUsage();
  const totalByModel = dict<ModelUsage>();
  const totalTools = dict<ToolStat>();
  const totalMcp = dict<McpServerStat>();
  const totalSkills = dict<number>();
  let totalToolCalls = 0;
  const totalByDay = dict<Record<string, ModelUsage>>();
  const totalFileEdits = dict<FileEditStat>();
  const totalToolErrors: ToolErrorEntry[] = [];
  const totalByHour = dict<Record<string, ModelUsage>>();
  const totalResultSizes = dict<ToolResultSize>();
  const totalFileReads = dict<FileReadStat>();
  let totalLargestResults: LargeResult[] = [];
  const agentLabel = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.transcriptPath) agentLabel.set(node.transcriptPath, `${node.agentType} · ${node.description || node.agentId}`);
  }
  for (const st of all) {
    for (const [day, models] of Object.entries(st.usageByDay)) {
      const d = (totalByDay[day] ??= dict());
      for (const [model, mu] of Object.entries(models)) {
        const dm = (d[model] ??= { ...emptyUsage(), messages: 0 });
        addUsage(dm, mu);
        dm.messages += mu.messages;
      }
    }
    for (const f of Object.values(st.fileEdits)) {
      const d = (totalFileEdits[f.path] ??= { path: f.path, edits: 0, writes: 0, failed: 0 });
      d.edits += f.edits;
      d.writes += f.writes;
      d.failed += f.failed;
      if (f.lastTime && (!d.lastTime || f.lastTime > d.lastTime)) d.lastTime = f.lastTime;
    }
    for (const [hour, models] of Object.entries(st.usageByHour)) {
      const d = (totalByHour[hour] ??= dict());
      for (const [model, mu] of Object.entries(models)) {
        const dm = (d[model] ??= { ...emptyUsage(), messages: 0 });
        addUsage(dm, mu);
        dm.messages += mu.messages;
      }
    }
    for (const r of Object.values(st.resultSizes)) {
      const d = (totalResultSizes[r.name] ??= { name: r.name, calls: 0, chars: 0 });
      d.calls += r.calls;
      d.chars += r.chars;
    }
    for (const r of Object.values(st.fileReads)) {
      const d = (totalFileReads[r.path] ??= { path: r.path, reads: 0, chars: 0 });
      d.reads += r.reads;
      d.chars += r.chars;
    }
    const agent = st === main ? undefined : agentLabel.get(st.filePath);
    totalLargestResults = totalLargestResults
      .concat(st.largestResults.map((r) => (agent ? { ...r, agent } : r)))
      .sort((a, b) => b.chars - a.chars)
      .slice(0, MAX_LARGE_RESULTS);
    for (const e of st.toolErrors) {
      if (totalToolErrors.length >= MAX_SESSION_TOOL_ERRORS) break;
      totalToolErrors.push(agent ? { ...e, agent } : e);
    }
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
    subagentFilesSkipped: scan.skipped || undefined,
    spawnNodesSkipped: spawnNodesSkipped || undefined,
    durationMs: durationOf(main),
    totalUsage,
    totalByModel,
    totalTools,
    totalMcp,
    totalSkills,
    totalToolCalls,
    totalByDay,
    totalToolErrors: totalToolErrors.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '')),
    totalFileEdits,
    totalByHour,
    totalResultSizes,
    totalLargestResults,
    totalFileReads,
    models: sortedModels(totalByModel),
  };
}

export function sessionTitle(stats: TranscriptStats, fallback: string): string {
  return stats.aiTitle ?? stats.summaryTitle ?? (stats.firstPrompt ? truncate(stats.firstPrompt, 80) : fallback);
}
