// Per-session pins, tags and notes, persisted in extension global state.

export interface SessionAnnotation {
  pinned?: boolean;
  tags?: string[];
  note?: string;
}

/** Subset of vscode.Memento used here (keeps this module testable without vscode). */
export interface StateStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

const KEY = 'agentwatch.annotations';
const MAX_TAGS = 20;
const MAX_TAG_CHARS = 40;
const MAX_NOTE_CHARS = 2000;

/** Normalise a comma/space separated tag list: trimmed, no leading '#', unique, bounded. */
export function parseTags(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.split(/[,\s]+/)) {
    const t = raw.replace(/^#+/, '').trim().slice(0, MAX_TAG_CHARS);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export class AnnotationStore {
  private readonly listeners: Array<() => void> = [];

  constructor(private readonly state: StateStore) {}

  private all(): Record<string, SessionAnnotation> {
    const v = this.state.get<Record<string, SessionAnnotation>>(KEY, {});
    return typeof v === 'object' && v !== null ? v : {};
  }

  get(sessionId: string): SessionAnnotation {
    return Object.prototype.hasOwnProperty.call(this.all(), sessionId) ? this.all()[sessionId] : {};
  }

  pinnedIds(): Set<string> {
    return new Set(Object.entries(this.all()).filter(([, a]) => a.pinned).map(([id]) => id));
  }

  onDidChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  async set(sessionId: string, patch: SessionAnnotation): Promise<void> {
    const all = { ...this.all() };
    const next: SessionAnnotation = { ...(Object.prototype.hasOwnProperty.call(all, sessionId) ? all[sessionId] : {}), ...patch };
    if (next.note !== undefined) next.note = next.note.slice(0, MAX_NOTE_CHARS) || undefined;
    if (next.tags && next.tags.length === 0) next.tags = undefined;
    if (!next.pinned) delete next.pinned;
    if (!next.pinned && !next.tags && !next.note) delete all[sessionId];
    else all[sessionId] = next;
    await this.state.update(KEY, all);
    for (const fn of this.listeners) fn();
  }

  async togglePin(sessionId: string): Promise<boolean> {
    const pinned = !this.get(sessionId).pinned;
    await this.set(sessionId, { pinned });
    return pinned;
  }
}
