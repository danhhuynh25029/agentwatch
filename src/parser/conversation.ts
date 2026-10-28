// On-demand reading of a transcript as a conversation (chat viewer, export, file diffs).
// Kept separate from the stats parser so the session summary stays small in memory.
import * as fs from 'fs';
import { cleanPromptText, DEFAULT_LIMITS, FILE_EDIT_TOOLS, forEachLine, previewJson, toolResultText, TranscriptReadLimits } from './parser';

const MAX_ENTRIES = 5000;
const MAX_TEXT_CHARS = 8000;
const MAX_TOOL_INPUT_CHARS = 2000;
const MAX_TOOL_RESULT_CHARS = 2000;
const MAX_EDIT_CHARS = 20000;
const MAX_EDITS_PER_FILE = 200;

export type ConversationEntry =
  | { kind: 'user'; timestamp?: string; text: string }
  | { kind: 'assistant'; timestamp?: string; text: string; model?: string; messageId?: string }
  | {
      kind: 'tool';
      timestamp?: string;
      id?: string;
      name: string;
      input: string;
      result?: string;
      isError?: boolean;
    }
  | { kind: 'compact'; timestamp?: string };

export interface Conversation {
  entries: ConversationEntry[];
  /** True if entries were dropped because of MAX_ENTRIES. */
  truncated: boolean;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function cut(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Incremental conversation builder; feed raw JSONL lines. */
export class ConversationBuilder {
  private readonly entries: ConversationEntry[] = [];
  private readonly toolById = new Map<string, Extract<ConversationEntry, { kind: 'tool' }>>();
  private truncated = false;

  private push(e: ConversationEntry): void {
    if (this.entries.length >= MAX_ENTRIES) {
      this.truncated = true;
      return;
    }
    this.entries.push(e);
  }

  addLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let o: unknown;
    try {
      o = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isObj(o)) return;
    try {
      this.handle(o);
    } catch {
      // Unexpected shapes are skipped.
    }
  }

  private handle(o: Json): void {
    const ts = str(o.timestamp);
    if (o.isCompactSummary === true || (o.type === 'system' && o.subtype === 'compact_boundary')) {
      const last = this.entries[this.entries.length - 1];
      if (last?.kind !== 'compact') this.push({ kind: 'compact', timestamp: ts });
      return;
    }
    const msg = o.message;
    if (!isObj(msg)) return;
    const content = msg.content;
    if (o.type === 'assistant') {
      const model = str(msg.model);
      const messageId = str(msg.id);
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (!isObj(b)) continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          const last = this.entries[this.entries.length - 1];
          if (last?.kind === 'assistant' && messageId && last.messageId === messageId) {
            last.text = cut(last.text + '\n\n' + b.text, MAX_TEXT_CHARS);
          } else {
            this.push({ kind: 'assistant', timestamp: ts, text: cut(b.text, MAX_TEXT_CHARS), model, messageId });
          }
        } else if (b.type === 'tool_use') {
          if (this.entries.length >= MAX_ENTRIES) {
            this.truncated = true;
            continue;
          }
          const id = str(b.id);
          if (id && this.toolById.has(id)) continue;
          const entry: Extract<ConversationEntry, { kind: 'tool' }> = {
            kind: 'tool',
            timestamp: ts,
            id,
            name: str(b.name) ?? '(unknown)',
            input: formatToolInput(b.input),
          };
          if (id) this.toolById.set(id, entry);
          this.push(entry);
        }
      }
      return;
    }
    if (o.type !== 'user') return;
    const texts: string[] = [];
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (!isObj(b)) continue;
        if (b.type === 'tool_result') {
          const tool = this.toolById.get(str(b.tool_use_id) ?? '');
          if (tool) {
            tool.result = cut(toolResultText(b.content), MAX_TOOL_RESULT_CHARS);
            tool.isError = b.is_error === true;
          }
        } else if (b.type === 'text' && typeof b.text === 'string') {
          texts.push(b.text);
        }
      }
    }
    if (o.isMeta === true) return;
    const cleaned = texts.map(cleanPromptText).filter((t): t is string => !!t);
    if (cleaned.length) this.push({ kind: 'user', timestamp: ts, text: cut(cleaned.join('\n\n'), MAX_TEXT_CHARS) });
  }

  finish(): Conversation {
    return { entries: this.entries, truncated: this.truncated };
  }
}

/** Pretty-printed tool input, cut to a readable size. */
function formatToolInput(input: unknown): string {
  if (!isObj(input)) return '';
  // Common tools: show the interesting field instead of JSON.
  if (typeof input.command === 'string' && Object.keys(input).every((k) => ['command', 'description', 'timeout'].includes(k))) {
    return cut(input.command, MAX_TOOL_INPUT_CHARS);
  }
  let text: string;
  try {
    text = JSON.stringify(input, null, 2);
  } catch {
    text = previewJson(input, MAX_TOOL_INPUT_CHARS);
  }
  return cut(text, MAX_TOOL_INPUT_CHARS);
}

async function streamLines(filePath: string, limits: TranscriptReadLimits, onLine: (line: string) => void): Promise<void> {
  const { size } = await fs.promises.stat(filePath);
  if (size > limits.maxTranscriptBytes) throw new Error('transcript too large to read');
  const stream = fs.createReadStream(filePath, { end: limits.maxTranscriptBytes - 1, highWaterMark: limits.highWaterMark });
  try {
    await forEachLine(stream, limits.maxLineBytes, onLine, () => undefined);
  } finally {
    stream.destroy();
  }
}

export async function readConversation(filePath: string, limits: TranscriptReadLimits = DEFAULT_LIMITS): Promise<Conversation> {
  const b = new ConversationBuilder();
  await streamLines(filePath, limits, (line) => b.addLine(line));
  return b.finish();
}

export function conversationFromText(text: string): Conversation {
  const b = new ConversationBuilder();
  for (const line of text.split('\n')) b.addLine(line);
  return b.finish();
}

/** One change made to a file by an edit tool call. */
export interface FileEditOp {
  timestamp?: string;
  tool: string;
  /** For Write: the new full content in `newText` and `oldText` empty. */
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  isError?: boolean;
  /** Transcript the call came from. */
  source: string;
}

/** Collect every Edit/MultiEdit/Write/NotebookEdit call on `targetPath` across transcripts. */
export async function collectFileEdits(
  transcripts: string[],
  targetPath: string,
  limits: TranscriptReadLimits = DEFAULT_LIMITS,
): Promise<FileEditOp[]> {
  const ops: FileEditOp[] = [];
  for (const source of transcripts) {
    const byId = new Map<string, FileEditOp[]>();
    try {
      await streamLines(source, limits, (line) => {
        // Cheap pre-filter: only tool_use / tool_result lines matter.
        if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) return;
        let o: unknown;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        if (!isObj(o) || !isObj(o.message) || !Array.isArray(o.message.content)) return;
        for (const b of o.message.content) {
          if (!isObj(b)) continue;
          if (b.type === 'tool_result') {
            const pending = byId.get(str(b.tool_use_id) ?? '');
            if (pending && b.is_error === true) for (const op of pending) op.isError = true;
            continue;
          }
          if (b.type !== 'tool_use' || ops.length >= MAX_EDITS_PER_FILE) continue;
          const name = str(b.name) ?? '';
          const input = b.input;
          if (!FILE_EDIT_TOOLS.has(name) || !isObj(input)) continue;
          if ((str(input.file_path) ?? str(input.notebook_path)) !== targetPath) continue;
          const found = editOpsFromInput(name, input, str(o.timestamp), source);
          ops.push(...found);
          const id = str(b.id);
          if (id) byId.set(id, found);
        }
      });
    } catch {
      // Unreadable transcript: skip it.
    }
  }
  return ops.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
}

function editOpsFromInput(name: string, input: Json, timestamp: string | undefined, source: string): FileEditOp[] {
  const s = (v: unknown) => cut(typeof v === 'string' ? v : '', MAX_EDIT_CHARS);
  if (name === 'Write') return [{ timestamp, tool: name, oldText: '', newText: s(input.content), source }];
  if (name === 'NotebookEdit') return [{ timestamp, tool: name, oldText: '', newText: s(input.new_source), source }];
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.filter(isObj).map((e) => ({
      timestamp,
      tool: name,
      oldText: s(e.old_string),
      newText: s(e.new_string),
      replaceAll: e.replace_all === true,
      source,
    }));
  }
  return [{ timestamp, tool: name, oldText: s(input.old_string), newText: s(input.new_string), replaceAll: input.replace_all === true, source }];
}

/** Unified-diff-like text for one edit (no line numbers: we do not know the file state). */
export function editOpToDiff(op: FileEditOp): string {
  const lines: string[] = [];
  if (op.oldText) for (const l of op.oldText.split('\n')) lines.push('- ' + l);
  if (op.newText) for (const l of op.newText.split('\n')) lines.push('+ ' + l);
  return lines.join('\n');
}
