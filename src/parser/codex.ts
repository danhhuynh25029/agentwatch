// OpenAI Codex CLI rollout transcripts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl), mapped onto
// the same data model as Claude Code sessions. Basic support: tokens, models, tools, prompts,
// conversation, context size. No vscode dependency.
import * as fs from 'fs';
import * as path from 'path';
import { Conversation, ConversationEntry, FileEditOp } from './conversation';
import { addUsage, emptyUsage, truncate } from './format';
import { DEFAULT_LIMITS, forEachLine, localDay, previewJson, TranscriptAccumulator, TranscriptReadLimits, utcHour } from './parser';
import { SessionSummary, TokenUsage, TranscriptStats } from './types';

const MAX_PROMPTS = 500;
const MAX_ENTRIES = 5000;
const MAX_TEXT = 8000;
const MAX_TOOL_TEXT = 2000;
const MAX_FILES = 5000;
const MAX_DIR_DEPTH = 4;
const MAX_TOOL_ERRORS = 200;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

/** True for Codex rollout file names. */
export function isCodexTranscript(filePath: string): boolean {
  return /^rollout-.+\.jsonl$/i.test(path.basename(filePath));
}

/** Session id (trailing UUID) from a rollout file name. */
export function codexSessionId(filePath: string): string {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path.basename(filePath));
  return m ? m[1] : path.basename(filePath, '.jsonl');
}

export interface PatchFileChange {
  path: string;
  kind: 'update' | 'add' | 'delete';
  /** One entry per hunk (update) or a single entry (add/delete). */
  hunks: Array<{ oldText: string; newText: string }>;
}

const MAX_PATCH_FILES = 200;

/** Parse a Codex `apply_patch` envelope into per-file changes. Relative paths resolve against `cwd`. */
export function parsePatch(patch: string, cwd?: string): PatchFileChange[] {
  if (!patch.includes('*** Begin Patch')) return [];
  const out: PatchFileChange[] = [];
  let cur: PatchFileChange | undefined;
  let oldL: string[] = [];
  let newL: string[] = [];
  const flush = () => {
    if (cur && (oldL.length || newL.length)) cur.hunks.push({ oldText: oldL.join('\n'), newText: newL.join('\n') });
    oldL = [];
    newL = [];
  };
  const resolve = (p: string) => (cwd && !path.isAbsolute(p) ? path.join(cwd, p) : p);
  for (const line of patch.split('\n')) {
    const header = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (header) {
      flush();
      if (out.length >= MAX_PATCH_FILES) break;
      const kind = header[1] === 'Update' ? 'update' : header[1] === 'Add' ? 'add' : 'delete';
      cur = { path: resolve(header[2].trim()), kind, hunks: [] };
      out.push(cur);
      if (kind === 'delete') cur.hunks.push({ oldText: '', newText: '' });
      continue;
    }
    if (!cur || line.startsWith('*** ')) continue;
    if (line.startsWith('@@')) {
      flush();
      continue;
    }
    if (line.startsWith('+')) newL.push(line.slice(1));
    else if (line.startsWith('-')) oldL.push(line.slice(1));
    else if (line.startsWith(' ')) {
      oldL.push(line.slice(1));
      newL.push(line.slice(1));
    }
  }
  flush();
  return out;
}

/** Patch text from a Codex tool call payload, if it is an apply_patch call. */
function patchText(p: Json): string | undefined {
  const raw = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : undefined;
  if (!raw || !raw.includes('*** Begin Patch')) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (isObj(parsed) && typeof parsed.input === 'string') return parsed.input;
    if (isObj(parsed) && Array.isArray(parsed.command)) return parsed.command.find((c: unknown) => typeof c === 'string' && c.includes('*** Begin Patch'));
  } catch {
    // raw patch text (custom tool call)
  }
  return raw;
}

/** Edits made to `targetPath` by apply_patch calls in a Codex rollout, oldest first. */
export async function collectCodexFileEdits(filePath: string, targetPath: string, limits: TranscriptReadLimits = DEFAULT_LIMITS): Promise<FileEditOp[]> {
  const ops: FileEditOp[] = [];
  let cwd: string | undefined;
  const stream = fs.createReadStream(filePath, { end: limits.maxTranscriptBytes - 1 });
  try {
    await forEachLine(stream, limits.maxLineBytes, (line) => {
      if (!line.includes('session_meta') && !line.includes('turn_context') && !line.includes('Begin Patch')) return;
      let o: unknown;
      try {
        o = JSON.parse(line);
      } catch {
        return;
      }
      if (!isObj(o) || !isObj(o.payload)) return;
      if (o.type === 'session_meta' || o.type === 'turn_context') {
        cwd ??= str(o.payload.cwd);
        return;
      }
      const text = patchText(o.payload);
      if (!text) return;
      for (const change of parsePatch(text, cwd)) {
        if (change.path !== targetPath) continue;
        for (const h of change.hunks) {
          if (ops.length >= 200) return;
          ops.push({ timestamp: str(o.timestamp), tool: change.kind === 'add' ? 'Write' : 'apply_patch', oldText: h.oldText, newText: h.newText, source: filePath });
        }
      }
    }, () => undefined);
  } finally {
    stream.destroy();
  }
  return ops;
}

/** Codex usage: input_tokens includes cached tokens; map to Claude's disjoint fields. */
function toUsage(u: unknown): TokenUsage {
  if (!isObj(u)) return emptyUsage();
  const input = num(u.input_tokens);
  const cached = Math.min(num(u.cached_input_tokens), input);
  return { input: input - cached, output: num(u.output_tokens), cacheWrite: 0, cacheRead: cached };
}

function diff(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    cacheWrite: 0,
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
  };
}

function outputText(v: unknown): { text: string; failed: boolean } {
  if (typeof v === 'string') {
    // shell outputs are often JSON {"output": "...", "metadata": {"exit_code": n}}
    try {
      const o = JSON.parse(v);
      if (isObj(o) && typeof o.output === 'string') {
        const code = isObj(o.metadata) ? o.metadata.exit_code : undefined;
        return { text: o.output, failed: typeof code === 'number' && code !== 0 };
      }
    } catch {
      // plain text
    }
    return { text: v, failed: false };
  }
  if (isObj(v)) return { text: typeof v.content === 'string' ? v.content : previewJson(v, MAX_TOOL_TEXT), failed: v.success === false };
  return { text: '', failed: false };
}

function messageText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(isObj)
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Incremental parser producing both stats and a conversation. */
export class CodexAccumulator {
  private readonly stats: TranscriptStats;
  private readonly entries: ConversationEntry[] = [];
  private readonly toolById = new Map<string, Extract<ConversationEntry, { kind: 'tool' }>>();
  private readonly nameById = new Map<string, string>();
  private model = 'codex';
  private lastTotal = emptyUsage();
  private startMs = Infinity;
  private endMs = -Infinity;
  private truncated = false;
  private sawUserEvent = false;
  /** Calls without output in the current turn (cleared when the turn ends or is interrupted). */
  private readonly openCalls = new Map<string, string>();

  constructor(private readonly filePath: string) {
    this.stats = new TranscriptAccumulator(filePath).finish();
    this.stats.models = [];
  }

  addLine(line: string): void {
    const t = line.trim();
    if (!t) return;
    this.stats.lines++;
    let o: unknown;
    try {
      o = JSON.parse(t);
    } catch {
      this.stats.badLines++;
      return;
    }
    if (!isObj(o)) {
      this.stats.badLines++;
      return;
    }
    try {
      this.handle(o);
    } catch {
      this.stats.badLines++;
    }
  }

  private push(e: ConversationEntry): void {
    if (this.entries.length >= MAX_ENTRIES) this.truncated = true;
    else this.entries.push(e);
  }

  private handle(o: Json): void {
    const ts = str(o.timestamp);
    const tms = ts ? Date.parse(ts) : NaN;
    if (Number.isFinite(tms)) {
      this.startMs = Math.min(this.startMs, tms);
      this.endMs = Math.max(this.endMs, tms);
    }
    const p = o.payload;
    if (!isObj(p)) return;
    const s = this.stats;
    switch (o.type) {
      case 'session_meta':
        s.sessionId ??= str(p.id) ?? str(p.session_id);
        s.cwd ??= str(p.cwd);
        s.version ??= str(p.cli_version);
        s.entrypoint ??= str(p.originator);
        if (isObj(p.git)) s.gitBranch ??= str(p.git.branch);
        return;
      case 'turn_context':
        this.model = str(p.model) ?? this.model;
        s.cwd ??= str(p.cwd);
        return;
      case 'event_msg':
        return this.handleEvent(p, ts, tms);
      case 'response_item':
        return this.handleItem(p, ts);
    }
  }

  private handleEvent(p: Json, ts: string | undefined, tms: number): void {
    const s = this.stats;
    if (p.type === 'task_complete' || p.type === 'turn_aborted' || p.type === 'user_message') {
      // A finished, aborted or new turn: calls still without output will not get one.
      this.openCalls.clear();
    }
    if (p.type === 'user_message' && typeof p.message === 'string' && p.message.trim()) {
      this.sawUserEvent = true;
      const text = p.message.trim();
      if (!s.firstPrompt) s.firstPrompt = truncate(text, 300);
      if (s.prompts.length < MAX_PROMPTS) s.prompts.push({ timestamp: ts, text: truncate(text, 300) });
      this.push({ kind: 'user', timestamp: ts, text: cut(text, MAX_TEXT) });
    } else if (p.type === 'agent_message' && typeof p.message === 'string' && p.message.trim()) {
      this.push({ kind: 'assistant', timestamp: ts, text: cut(p.message, MAX_TEXT), model: this.model });
    } else if (p.type === 'task_complete') {
      s.lastStopReason = 'end_turn';
      s.turnEndedAt = ts;
    } else if (p.type === 'token_count' && isObj(p.info)) {
      const total = toUsage(p.info.total_token_usage);
      const delta = diff(total, this.lastTotal);
      this.lastTotal = total;
      const deltaTokens = delta.input + delta.output + delta.cacheRead;
      if (deltaTokens > 0) {
        s.apiMessages++;
        const m = (s.usageByModel[this.model] ??= { ...emptyUsage(), messages: 0 });
        addUsage(m, delta);
        m.messages++;
        addUsage(s.usage, delta);
        if (Number.isFinite(tms)) {
          for (const [map, key] of [[s.usageByDay, localDay(tms)], [s.usageByHour, utcHour(tms)]] as const) {
            const bucket = (map[key] ??= Object.create(null));
            const x = (bucket[this.model] ??= { ...emptyUsage(), messages: 0 });
            addUsage(x, delta);
            x.messages++;
          }
        }
        const last = toUsage(p.info.last_token_usage);
        s.context.push({ i: s.context.length, timestamp: ts, tokens: last.input + last.cacheRead });
      }
    }
  }

  private handleItem(p: Json, ts: string | undefined): void {
    const s = this.stats;
    if (p.type === 'message') {
      // Prompts come from user_message events; fall back to items for older rollouts.
      if (p.role === 'user' && !this.sawUserEvent) {
        const text = messageText(p.content).trim();
        if (text && !text.startsWith('<')) {
          if (!s.firstPrompt) s.firstPrompt = truncate(text, 300);
          if (s.prompts.length < MAX_PROMPTS) s.prompts.push({ timestamp: ts, text: truncate(text, 300) });
          this.push({ kind: 'user', timestamp: ts, text: cut(text, MAX_TEXT) });
        }
      }
      return;
    }
    if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      const name = str(p.name) ?? (p.type === 'local_shell_call' ? 'shell' : '(unknown)');
      const id = str(p.call_id) ?? str(p.id);
      let input = typeof p.arguments === 'string' ? p.arguments : typeof p.input === 'string' ? p.input : previewJson(p.action ?? p.arguments, MAX_TOOL_TEXT);
      try {
        const parsed = JSON.parse(input);
        if (isObj(parsed) && Array.isArray(parsed.command)) input = parsed.command.join(' ');
        else input = JSON.stringify(parsed, null, 2);
      } catch {
        // keep raw
      }
      s.toolCalls++;
      const tool = (s.tools[name] ??= { name, calls: 0, errors: 0 });
      tool.calls++;
      const patch = patchText(p);
      if (patch) {
        for (const change of parsePatch(patch, s.cwd)) {
          let stat = s.fileEdits[change.path];
          if (!stat) {
            if (Object.keys(s.fileEdits).length >= MAX_FILES) continue;
            stat = s.fileEdits[change.path] = { path: change.path, edits: 0, writes: 0, failed: 0 };
          }
          if (change.kind === 'add') stat.writes++;
          else stat.edits++;
          if (ts) stat.lastTime = ts;
        }
      }
      if (id) this.nameById.set(id, name);
      const entry: Extract<ConversationEntry, { kind: 'tool' }> = { kind: 'tool', timestamp: ts, id, name, input: cut(input, MAX_TOOL_TEXT) };
      if (id && this.entries.length < MAX_ENTRIES) this.toolById.set(id, entry);
      if (id) this.openCalls.set(id, name);
      this.push(entry);
      return;
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const id = str(p.call_id);
      const { text, failed } = outputText(p.output);
      const name = (id && this.nameById.get(id)) || '(unknown)';
      const size = (s.resultSizes[name] ??= { name, calls: 0, chars: 0 });
      size.calls++;
      size.chars += text.length;
      const entry = id ? this.toolById.get(id) : undefined;
      if (entry) {
        entry.result = cut(text, MAX_TOOL_TEXT);
        entry.isError = failed;
      }
      if (failed) {
        (s.tools[name] ??= { name, calls: 0, errors: 0 }).errors++;
        if (s.toolErrors.length < MAX_TOOL_ERRORS) s.toolErrors.push({ timestamp: ts, tool: name, input: entry?.input.slice(0, 300) ?? '', error: truncate(text, 500) });
      }
      if (id) {
        this.toolById.delete(id);
        this.openCalls.delete(id);
        this.nameById.delete(id);
      }
    }
  }

  finish(): { summary: SessionSummary; conversation: Conversation } {
    const s = this.stats;
    if (Number.isFinite(this.startMs)) s.startTime = new Date(this.startMs).toISOString();
    if (Number.isFinite(this.endMs)) s.endTime = new Date(this.endMs).toISOString();
    s.models = Object.keys(s.usageByModel);
    s.pendingTools = [...this.openCalls.values()].slice(-5);
    if (s.context.length > 300) s.context = s.context.filter((_, i) => i % Math.ceil(s.context.length / 300) === 0);
    const sessionId = s.sessionId ?? codexSessionId(this.filePath);
    const durationMs = s.startTime && s.endTime ? Date.parse(s.endTime) - Date.parse(s.startTime) : undefined;
    const summary: SessionSummary = {
      filePath: this.filePath,
      sessionId,
      title: s.firstPrompt ? truncate(s.firstPrompt, 80) : `Codex ${sessionId.slice(0, 8)}`,
      main: s,
      subagents: [],
      agentCount: 0,
      durationMs,
      totalUsage: { ...s.usage },
      totalByModel: s.usageByModel,
      totalTools: s.tools,
      totalMcp: s.mcp,
      totalSkills: s.skills,
      totalToolCalls: s.toolCalls,
      totalByDay: s.usageByDay,
      totalToolErrors: s.toolErrors,
      totalFileEdits: s.fileEdits,
      totalByHour: s.usageByHour,
      totalResultSizes: s.resultSizes,
      totalLargestResults: s.largestResults,
      totalFileReads: s.fileReads,
      models: s.models,
    };
    return { summary, conversation: { entries: this.entries, truncated: this.truncated } };
  }
}

export async function parseCodexFile(filePath: string, limits: TranscriptReadLimits = DEFAULT_LIMITS): Promise<{ summary: SessionSummary; conversation: Conversation }> {
  const acc = new CodexAccumulator(filePath);
  const { size } = await fs.promises.stat(filePath);
  if (size > limits.maxTranscriptBytes) {
    const r = acc.finish();
    r.summary.main.skipped = 'file too large, not parsed';
    return r;
  }
  const stream = fs.createReadStream(filePath, { end: limits.maxTranscriptBytes - 1 });
  try {
    await forEachLine(stream, limits.maxLineBytes, (l) => acc.addLine(l), () => undefined);
  } finally {
    stream.destroy();
  }
  return acc.finish();
}

export function parseCodexText(text: string, filePath = '<memory>'): { summary: SessionSummary; conversation: Conversation } {
  const acc = new CodexAccumulator(filePath);
  for (const l of text.split('\n')) acc.addLine(l);
  return acc.finish();
}

export interface CodexFileInfo {
  filePath: string;
  mtimeMs: number;
  size: number;
}

/**
 * Rollout files under `root`, newest first. Directories are YYYY/MM/DD and file names start with
 * a timestamp, so walking names in descending order keeps the newest files when the cap is hit.
 */
export async function listCodexSessions(root: string): Promise<CodexFileInfo[]> {
  const out: CodexFileInfo[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DIR_DEPTH || out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.isFile() && isCodexTranscript(e.name) && out.length < MAX_FILES) {
        try {
          const st = await fs.promises.stat(full);
          out.push({ filePath: full, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // vanished
        }
      }
    }
  };
  await walk(root, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
