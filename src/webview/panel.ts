import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { AnnotationStore } from '../annotations';
import { sessionDirFor } from '../parser/parser';
import { Pricing } from '../parser/pricing';
import { SessionStore } from '../parser/store';
import { renderMessage } from './html';
import { renderSession } from './render';

export function nonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

/** Message posted by our webview script: an action name and an optional integer index. */
export interface WebviewAction {
  command: string;
  index?: number;
}

export function parseAction(msg: unknown): WebviewAction | undefined {
  if (typeof msg !== 'object' || msg === null) return undefined;
  const m = msg as { command?: unknown; index?: unknown };
  if (typeof m.command !== 'string') return undefined;
  const index = typeof m.index === 'number' && Number.isInteger(m.index) && m.index >= 0 ? m.index : undefined;
  return { command: m.command, index };
}

export interface SessionPanelDeps {
  store: SessionStore;
  annotations: AnnotationStore;
  getPricing(): Pricing;
  /** True if the session file was modified recently enough to count as running. */
  isLive(mtimeMs: number): boolean;
  /** Reload panels automatically when their transcripts change. */
  liveReload(): boolean;
}

const LIVE_RELOAD_DEBOUNCE_MS = 1500;

/** One webview panel per session file; re-opening reveals the existing panel. */
export class SessionPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, SessionPanel>();

  constructor(private readonly deps: SessionPanelDeps) {}

  async open(filePath: string): Promise<void> {
    const existing = this.panels.get(filePath);
    if (existing) {
      existing.reveal();
      await existing.load();
      return;
    }
    const panel = new SessionPanel(filePath, this.deps, () => this.panels.delete(filePath));
    this.panels.set(filePath, panel);
    await panel.load();
  }

  /** A transcript changed on disk: reload the panel of the session it belongs to (debounced). */
  notifyChanged(fsPath: string): void {
    if (!this.deps.liveReload()) return;
    for (const [sessionPath, panel] of this.panels) {
      const dir = sessionDirFor(sessionPath) + path.sep;
      if (fsPath === sessionPath || fsPath.startsWith(dir)) panel.scheduleReload(LIVE_RELOAD_DEBOUNCE_MS);
    }
  }

  /** Re-render all panels (pins, tags or prices changed). */
  reloadAll(): void {
    for (const p of this.panels.values()) void p.load();
  }

  dispose(): void {
    for (const p of [...this.panels.values()]) p.dispose();
    this.panels.clear();
  }
}

class SessionPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private transcripts: string[] = [];
  private files: string[] = [];
  private loadSeq = 0;
  private disposed = false;
  private reloadTimer: NodeJS.Timeout | undefined;
  /** A transcript change arrived while the panel was hidden. */
  private stale = false;

  constructor(
    private readonly filePath: string,
    private readonly deps: SessionPanelDeps,
    private readonly onDispose: () => void,
  ) {
    this.panel = vscode.window.createWebviewPanel('agentwatch.session', 'AgentWatch', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [],
      retainContextWhenHidden: false,
    });
    this.panel.webview.html = renderMessage('Parsing session…', nonce());
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible && this.stale) {
          this.stale = false;
          void this.load();
        }
      },
      null,
      this.disposables,
    );
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
  }

  reveal(): void {
    this.panel.reveal();
  }

  /** Throttled: at most one reload per `ms`, so a constantly growing transcript still refreshes. */
  scheduleReload(ms: number): void {
    if (!this.panel.visible) {
      this.stale = true;
      return;
    }
    if (this.reloadTimer) return;
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.load();
    }, ms);
  }

  async load(): Promise<void> {
    // Guard against out-of-order completion when refresh is clicked repeatedly.
    const seq = ++this.loadSeq;
    try {
      const summary = await this.deps.store.getSummaryByPath(this.filePath);
      if (this.disposed || seq !== this.loadSeq) return;
      let mtimeMs = 0;
      try {
        mtimeMs = (await vscode.workspace.fs.stat(vscode.Uri.file(this.filePath))).mtime;
      } catch {
        // Ignore: only used for the live badge.
      }
      const { html, transcripts, files } = renderSession(summary, nonce(), this.panel.webview.cspSource, {
        pricing: this.deps.getPricing(),
        annotation: this.deps.annotations.get(path.basename(this.filePath, '.jsonl')),
        live: this.deps.isLive(mtimeMs),
      });
      if (this.disposed || seq !== this.loadSeq) return;
      this.transcripts = transcripts;
      this.files = files;
      this.panel.title = summary.title.length > 40 ? summary.title.slice(0, 39) + '…' : summary.title;
      this.panel.webview.html = html;
    } catch (err) {
      if (this.disposed || seq !== this.loadSeq) return;
      this.panel.webview.html = renderMessage(`Failed to load ${this.filePath}: ${String(err)}`, nonce());
    }
  }

  private onMessage(msg: unknown): void {
    const a = parseAction(msg);
    if (!a) return;
    const run = (command: string, ...args: unknown[]) => void vscode.commands.executeCommand(command, ...args);
    // Only paths we rendered ourselves are used; the webview never supplies a path.
    switch (a.command) {
      case 'refresh':
        void this.load();
        break;
      case 'openTranscript': {
        const target = a.index !== undefined ? this.transcripts[a.index] : undefined;
        if (target) run('agentwatch.openTranscript', target);
        break;
      }
      case 'openFile': {
        const file = a.index !== undefined ? this.files[a.index] : undefined;
        if (file) run('agentwatch.openEditedFile', { sessionPath: this.filePath, file });
        break;
      }
      case 'fileEdits': {
        const file = a.index !== undefined ? this.files[a.index] : undefined;
        if (file) run('agentwatch.showFileEdits', { sessionPath: this.filePath, file });
        break;
      }
      case 'conversation':
        run('agentwatch.viewConversation', this.filePath);
        break;
      case 'resume':
        run('agentwatch.resumeSession', this.filePath);
        break;
      case 'export':
        run('agentwatch.exportSession', this.filePath);
        break;
      case 'compare':
        run('agentwatch.compareSessions', this.filePath);
        break;
      case 'pin':
        run('agentwatch.togglePin', this.filePath);
        break;
      case 'tags':
        run('agentwatch.editTags', this.filePath);
        break;
      case 'note':
        run('agentwatch.editNote', this.filePath);
        break;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.onDispose();
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

/** Rendered content of a generic panel plus its action handler. */
export interface PanelContent {
  html: string;
  title: string;
  onAction?: (a: WebviewAction) => void;
}

/**
 * Generic keyed webview panel (conversation, dashboard, compare). `load` is re-run on the
 * 'refresh' action and when `show` is called again for the same key.
 */
export class KeyedPanels implements vscode.Disposable {
  private readonly panels = new Map<
    string,
    { panel: vscode.WebviewPanel; load: () => Promise<void>; render: (cspSource: string, nonce: string) => Promise<PanelContent> }
  >();

  constructor(private readonly viewType: string) {}

  async show(key: string, render: (cspSource: string, nonce: string) => Promise<PanelContent>): Promise<void> {
    let entry = this.panels.get(key);
    if (entry) {
      entry.render = render;
      entry.panel.reveal();
    } else {
      const panel = vscode.window.createWebviewPanel(this.viewType, 'AgentWatch', vscode.ViewColumn.Active, {
        enableScripts: true,
        localResourceRoots: [],
      });
      panel.webview.html = renderMessage('Loading…', nonce());
      let onAction: PanelContent['onAction'];
      let seq = 0;
      let disposed = false;
      const load = async () => {
        const my = ++seq;
        try {
          const content = await created.render(panel.webview.cspSource, nonce());
          if (disposed || my !== seq) return;
          panel.title = content.title.length > 40 ? content.title.slice(0, 39) + '…' : content.title;
          panel.webview.html = content.html;
          onAction = content.onAction;
        } catch (err) {
          if (disposed || my !== seq) return;
          panel.webview.html = renderMessage(`Failed to load: ${String(err)}`, nonce());
        }
      };
      panel.webview.onDidReceiveMessage((msg) => {
        const a = parseAction(msg);
        if (!a) return;
        if (a.command === 'refresh') void load();
        else onAction?.(a);
      });
      panel.onDidDispose(() => {
        disposed = true;
        this.panels.delete(key);
      });
      const created = { panel, load, render };
      entry = created;
      this.panels.set(key, entry);
    }
    await entry.load();
  }

  dispose(): void {
    for (const e of [...this.panels.values()]) e.panel.dispose();
    this.panels.clear();
  }
}
