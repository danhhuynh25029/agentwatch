// Full-text search over a conversation (prompts, replies, tool inputs and results). No vscode dependency.
import { Conversation } from './conversation';

export interface SearchHit {
  /** Index of the entry in conversation.entries. */
  entry: number;
  /** Where the match is: "You", "Assistant", or the tool name (with "input"/"result"). */
  where: string;
  /** Text around the match, on one line. */
  snippet: string;
  timestamp?: string;
}

const CONTEXT_CHARS = 60;

/** One-line excerpt of `text` around position `at` (match length `len`). */
export function snippetAround(text: string, at: number, len: number): string {
  const from = Math.max(0, at - CONTEXT_CHARS);
  const to = Math.min(text.length, at + len + CONTEXT_CHARS);
  return (from > 0 ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ').trim() + (to < text.length ? '…' : '');
}

/**
 * Case-insensitive matches of `query` in a conversation, at most one per field, in order.
 * Texts are the conversation viewer's (cut at a few thousand characters per message).
 */
export function searchConversation(conv: Conversation, query: string, maxHits = 50): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: SearchHit[] = [];
  const check = (text: string | undefined, entry: number, where: string, timestamp?: string) => {
    if (!text || hits.length >= maxHits) return;
    const at = text.toLowerCase().indexOf(needle);
    if (at >= 0) hits.push({ entry, where, snippet: snippetAround(text, at, needle.length), timestamp });
  };
  conv.entries.forEach((e, i) => {
    if (e.kind === 'user') check(e.text, i, 'You', e.timestamp);
    else if (e.kind === 'assistant') check(e.text, i, 'Assistant', e.timestamp);
    else if (e.kind === 'tool') {
      check(e.input, i, `${e.name} input`, e.timestamp);
      check(e.result, i, `${e.name} result`, e.timestamp);
    }
  });
  return hits;
}
