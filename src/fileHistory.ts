import * as path from 'path';
import * as vscode from 'vscode';
import { formatRelativeTime } from './parser/format';
import { mapPool } from './parser/parser';
import { formatUsd, Pricing } from './parser/pricing';
import { ProjectInfo, SessionFileInfo, SessionStore } from './parser/store';
import { FileEditStat } from './parser/types';

/** Sessions per matching project that are scanned for edits to a file. */
const MAX_SESSIONS_SCANNED = 40;

export interface FileHistoryEntry {
  info: SessionFileInfo;
  title: string;
  stat: FileEditStat;
  cost: number;
}

function isInside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Finds which sessions edited a given file. Results are cached until `invalidate()`. */
export class FileHistoryIndex {
  private readonly cache = new Map<string, Promise<FileHistoryEntry[]>>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidInvalidate = this.emitter.event;

  constructor(
    private readonly store: SessionStore,
    private readonly getProjects: () => Promise<ProjectInfo[]>,
    private readonly getPricing: () => Pricing,
  ) {}

  invalidate(): void {
    this.cache.clear();
    this.emitter.fire();
  }

  sessionsFor(file: string): Promise<FileHistoryEntry[]> {
    let p = this.cache.get(file);
    if (!p) {
      p = this.compute(file).catch(() => []);
      this.cache.set(file, p);
      // Bounded cache: drop the oldest entries.
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value as string);
    }
    return p;
  }

  private async compute(file: string): Promise<FileHistoryEntry[]> {
    const projects = await this.getProjects();
    const candidates: SessionFileInfo[] = [];
    for (const p of projects) {
      const cwd = (await this.store.peek(p.sessions[0])).cwd;
      if (cwd && isInside(file, cwd)) candidates.push(...p.sessions.slice(0, MAX_SESSIONS_SCANNED));
    }
    const found = await mapPool(candidates, 2, async (info) => {
      try {
        const s = await this.store.getSummary(info);
        const stat = Object.prototype.hasOwnProperty.call(s.totalFileEdits, file) ? s.totalFileEdits[file] : undefined;
        return stat ? { info, title: s.title, stat, cost: this.getPricing().costByModel(s.totalByModel) } : undefined;
      } catch {
        return undefined;
      }
    });
    return found.filter((x): x is FileHistoryEntry => !!x).sort((a, b) => (b.stat.lastTime ?? '').localeCompare(a.stat.lastTime ?? ''));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

type HistoryNode = { kind: 'entry'; file: string; entry: FileHistoryEntry } | { kind: 'message'; text: string };

/** "File History" view: sessions that edited the file in the active editor. */
export class FileHistoryProvider implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private file: string | undefined;

  constructor(private readonly index: FileHistoryIndex) {
    const update = () => {
      const doc = vscode.window.activeTextEditor?.document;
      const next = doc?.uri.scheme === 'file' ? doc.uri.fsPath : undefined;
      if (next !== this.file) {
        this.file = next;
        this.emitter.fire();
      }
    };
    this.disposables.push(vscode.window.onDidChangeActiveTextEditor(update), index.onDidInvalidate(() => this.emitter.fire()));
    update();
  }

  getTreeItem(node: HistoryNode): vscode.TreeItem {
    if (node.kind === 'message') return new vscode.TreeItem(node.text);
    const { entry } = node;
    const item = new vscode.TreeItem(entry.title);
    const parts = [];
    if (entry.stat.edits) parts.push(`${entry.stat.edits} edit${entry.stat.edits > 1 ? 's' : ''}`);
    if (entry.stat.writes) parts.push(`${entry.stat.writes} write${entry.stat.writes > 1 ? 's' : ''}`);
    if (entry.stat.lastTime) parts.push(formatRelativeTime(Date.parse(entry.stat.lastTime)));
    parts.push(formatUsd(entry.cost));
    item.description = parts.join(' · ');
    item.tooltip = `${entry.title}\n${entry.info.sessionId}\nClick to see the changes this session made to the file.`;
    item.iconPath = new vscode.ThemeIcon('history');
    item.contextValue = 'fileHistoryEntry';
    item.command = {
      command: 'agentwatch.showFileEdits',
      title: 'Show Changes',
      arguments: [{ sessionPath: entry.info.filePath, file: node.file }],
    };
    return item;
  }

  async getChildren(node?: HistoryNode): Promise<HistoryNode[]> {
    if (node) return [];
    const file = this.file;
    if (!file) return [{ kind: 'message', text: 'Open a file to see which sessions changed it.' }];
    const entries = await this.index.sessionsFor(file);
    if (entries.length === 0) return [{ kind: 'message', text: `No session edited ${path.basename(file)}.` }];
    return entries.map((entry) => ({ kind: 'entry', file, entry }));
  }

  dispose(): void {
    this.emitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** CodeLens on line 1: "Edited in N Claude sessions". */
export class FileHistoryCodeLens implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly index: FileHistoryIndex) {
    this.sub = index.onDidInvalidate(() => this.emitter.fire());
  }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (doc.uri.scheme !== 'file' || !vscode.workspace.getConfiguration('agentwatch').get<boolean>('codeLens.enabled', true)) return [];
    const entries = await this.index.sessionsFor(doc.uri.fsPath);
    if (entries.length === 0) return [];
    const last = entries[0].stat.lastTime ? ` · last ${formatRelativeTime(Date.parse(entries[0].stat.lastTime))}` : '';
    return [
      new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: `$(hubot) Edited in ${entries.length} Claude session${entries.length > 1 ? 's' : ''}${last}`,
        command: 'agentwatch.fileHistory',
        arguments: [doc.uri.fsPath],
      }),
    ];
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}
