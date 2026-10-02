import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { SessionStore } from '../parser/store';
import { renderMessage, renderSession } from './render';

function nonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

/** One webview panel per session file; re-opening reveals the existing panel. */
export class SessionPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, SessionPanel>();

  constructor(private readonly store: SessionStore) {}

  async open(filePath: string): Promise<void> {
    const existing = this.panels.get(filePath);
    if (existing) {
      existing.reveal();
      await existing.load();
      return;
    }
    const panel = new SessionPanel(filePath, this.store, () => this.panels.delete(filePath));
    this.panels.set(filePath, panel);
    await panel.load();
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
  private loadSeq = 0;
  private disposed = false;

  constructor(
    private readonly filePath: string,
    private readonly store: SessionStore,
    private readonly onDispose: () => void,
  ) {
    this.panel = vscode.window.createWebviewPanel('agentwatch.session', 'AgentWatch', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [],
      retainContextWhenHidden: false,
    });
    this.panel.webview.html = renderMessage('Parsing session…', nonce());
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
  }

  reveal(): void {
    this.panel.reveal();
  }

  async load(): Promise<void> {
    // Guard against out-of-order completion when refresh is clicked repeatedly.
    const seq = ++this.loadSeq;
    try {
      const summary = await this.store.getSummaryByPath(this.filePath);
      if (this.disposed || seq !== this.loadSeq) return;
      const n = nonce();
      const { html, transcripts } = renderSession(summary, n, this.panel.webview.cspSource);
      this.transcripts = transcripts;
      this.panel.title = summary.title.length > 40 ? summary.title.slice(0, 39) + '…' : summary.title;
      this.panel.webview.html = html;
    } catch (err) {
      if (this.disposed || seq !== this.loadSeq) return;
      this.panel.webview.html = renderMessage(`Failed to load ${this.filePath}: ${String(err)}`, nonce());
    }
  }

  private onMessage(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { command?: unknown; index?: unknown };
    if (m.command === 'refresh') {
      void this.load();
    } else if (m.command === 'openTranscript' && typeof m.index === 'number' && Number.isInteger(m.index)) {
      // Only paths we rendered ourselves are openable; the webview never supplies a path.
      const target = this.transcripts[m.index];
      if (target) void vscode.commands.executeCommand('agentwatch.openTranscript', target);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onDispose();
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
