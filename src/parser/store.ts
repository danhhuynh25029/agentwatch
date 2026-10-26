import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSession, peekTranscript, sessionTitle } from './parser';
import { SessionSummary } from './types';

export interface SessionFileInfo {
  filePath: string;
  sessionId: string;
  projectDir: string;
  mtimeMs: number;
  size: number;
}

export interface ProjectInfo {
  dirName: string;
  dirPath: string;
  /** Lossy decode of the folder name; prefer `cwd` once known. */
  decodedPath: string;
  sessions: SessionFileInfo[];
  latestMtimeMs: number;
}

export interface SessionPeek {
  cwd?: string;
  title?: string;
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Claude Code encodes a cwd as a folder name by replacing every non-alphanumeric char with '-'. */
export function encodeProjectPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

export function decodeProjectDirName(name: string): string {
  return name.startsWith('-') ? name.replace(/-/g, '/') : name;
}

export async function listSessions(projectDir: string): Promise<SessionFileInfo[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SessionFileInfo[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const filePath = path.join(projectDir, e.name);
    try {
      const st = await fs.promises.stat(filePath);
      out.push({ filePath, sessionId: e.name.slice(0, -'.jsonl'.length), projectDir, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // File vanished between readdir and stat.
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export async function listProjects(root: string): Promise<ProjectInfo[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ProjectInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dirPath = path.join(root, e.name);
    const sessions = await listSessions(dirPath);
    if (sessions.length === 0) continue;
    out.push({
      dirName: e.name,
      dirPath,
      decodedPath: decodeProjectDirName(e.name),
      sessions,
      latestMtimeMs: sessions[0].mtimeMs,
    });
  }
  out.sort((a, b) => b.latestMtimeMs - a.latestMtimeMs);
  return out;
}

/** Small bounded LRU map (Map preserves insertion order). */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

function cacheKey(info: { filePath: string; mtimeMs: number; size: number }): string {
  return `${info.filePath}|${info.mtimeMs}|${info.size}`;
}

/**
 * Caches parse results keyed by path+mtime+size, and de-duplicates concurrent parses of the
 * same file so expanding a tree node and opening the panel at once only parses once.
 */
export class SessionStore {
  private readonly summaries = new LruCache<string, SessionSummary>(100);
  private readonly peeks = new LruCache<string, SessionPeek>(5000);
  private readonly inflight = new Map<string, Promise<SessionSummary>>();

  getCached(info: SessionFileInfo): SessionSummary | undefined {
    return this.summaries.get(cacheKey(info));
  }

  /** Parse (or return cached) summary for a session file. */
  async getSummary(info: SessionFileInfo): Promise<SessionSummary> {
    const key = cacheKey(info);
    const hit = this.summaries.get(key);
    if (hit) return hit;
    let p = this.inflight.get(key);
    if (!p) {
      p = parseSession(info.filePath)
        .then((s) => {
          this.summaries.set(key, s);
          return s;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  /** Summary for a path, re-stat'ing the file to build the cache key. */
  async getSummaryByPath(filePath: string): Promise<SessionSummary> {
    const st = await fs.promises.stat(filePath);
    return this.getSummary({
      filePath,
      sessionId: path.basename(filePath, '.jsonl'),
      projectDir: path.dirname(filePath),
      mtimeMs: st.mtimeMs,
      size: st.size,
    });
  }

  getCachedPeek(info: SessionFileInfo): SessionPeek | undefined {
    return this.peeks.get(cacheKey(info));
  }

  /** Cheap head-of-file read for cwd and a provisional title. */
  async peek(info: SessionFileInfo): Promise<SessionPeek> {
    const key = cacheKey(info);
    const hit = this.peeks.get(key);
    if (hit) return hit;
    let result: SessionPeek;
    try {
      const st = await peekTranscript(info.filePath);
      result = {
        cwd: st.cwd,
        title: st.aiTitle || st.summaryTitle || st.firstPrompt ? sessionTitle(st, info.sessionId) : undefined,
      };
    } catch {
      result = {};
    }
    this.peeks.set(key, result);
    return result;
  }

  clear(): void {
    this.summaries.clear();
    this.peeks.clear();
  }
}

/**
 * True if a project (folder name + real cwd) belongs to one of the workspace folders:
 * exact cwd match, cwd inside a folder, or folder name equal to the encoded folder path.
 */
export function matchesWorkspace(dirName: string, cwd: string | undefined, folders: string[]): boolean {
  for (const f of folders) {
    const root = f.replace(/[\\/]+$/, '');
    if (!root) continue;
    if (cwd && (cwd === root || cwd.startsWith(root + path.sep) || cwd.startsWith(root + '/'))) return true;
    if (!cwd && encodeProjectPath(root) === dirName) return true;
  }
  return false;
}

/**
 * Validate a transcript path received as a command argument: it must be a `.jsonl` file that
 * resolves (after following symlinks) inside `root`. Returns the absolute path, or undefined.
 */
export async function resolveTranscriptUnderRoot(root: string, filePath: string): Promise<string | undefined> {
  if (!root || !filePath || !filePath.toLowerCase().endsWith('.jsonl')) return undefined;
  let realRoot: string;
  let realFile: string;
  try {
    [realRoot, realFile] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(filePath)]);
  } catch {
    return undefined;
  }
  if (!realFile.toLowerCase().endsWith('.jsonl')) return undefined;
  const rel = path.relative(realRoot, realFile);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return undefined;
  try {
    if (!(await fs.promises.stat(realFile)).isFile()) return undefined;
  } catch {
    return undefined;
  }
  // Return the caller's (absolute) path rather than the realpath so cache/panel keys stay stable.
  // Residual TOCTOU: a symlink swapped between this check and the open could redirect the read,
  // but that requires local write access inside the projects root, so it is accepted.
  return path.resolve(filePath);
}
