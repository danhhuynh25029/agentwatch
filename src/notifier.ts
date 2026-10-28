import * as path from 'path';
import * as vscode from 'vscode';
import { SessionStore } from './parser/store';

const TICK_MS = 5000;
/** A turn counts as finished once the transcript has been quiet this long. */
const FINISH_IDLE_MS = 4000;
/** Stop watching a transcript after this much inactivity. */
const FORGET_MS = 15 * 60 * 1000;

interface Watched {
  lastChange: number;
  notifiedTurn?: string;
  notifiedWaiting?: string;
}

/**
 * Notifies when a session that changed while VS Code was running finishes its turn, or seems to
 * be waiting (a tool call without result for a while: a permission prompt or a long command).
 */
export class SessionNotifier implements vscode.Disposable {
  private readonly watched = new Map<string, Watched>();
  private readonly timer: NodeJS.Timeout;
  private ticking = false;

  constructor(private readonly store: SessionStore) {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  /** Call for every changed main transcript (not subagent files). */
  onChanged(filePath: string): void {
    const w = this.watched.get(filePath);
    if (w) w.lastChange = Date.now();
    else this.watched.set(filePath, { lastChange: Date.now() });
  }

  private config() {
    const c = vscode.workspace.getConfiguration('agentwatch.notify');
    return {
      onFinish: c.get<boolean>('onFinish', true),
      onWaiting: c.get<boolean>('onWaiting', true),
      waitingMs: Math.max(5, c.get<number>('waitingSeconds', 30)) * 1000,
      onlyWhenUnfocused: c.get<boolean>('onlyWhenUnfocused', true),
    };
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const cfg = this.config();
      const now = Date.now();
      for (const [filePath, w] of [...this.watched]) {
        const idle = now - w.lastChange;
        if (idle > FORGET_MS) {
          this.watched.delete(filePath);
          continue;
        }
        if (idle < FINISH_IDLE_MS || (!cfg.onFinish && !cfg.onWaiting)) continue;
        let summary;
        try {
          summary = await this.store.getSummaryByPath(filePath);
        } catch {
          continue;
        }
        const m = summary.main;
        const quiet = cfg.onlyWhenUnfocused && vscode.window.state.focused;
        if (m.pendingTools.length === 0 && m.turnEndedAt && m.turnEndedAt !== w.notifiedTurn) {
          const first = w.notifiedTurn === undefined && Date.parse(m.turnEndedAt) < w.lastChange - 60_000;
          w.notifiedTurn = m.turnEndedAt;
          w.notifiedWaiting = undefined;
          // Skip turns that ended before we started watching this file.
          if (first || !cfg.onFinish || quiet) continue;
          void this.show(`✅ Claude finished: ${summary.title}`, filePath);
        } else if (m.pendingTools.length && idle >= cfg.waitingMs) {
          const sig = `${m.pendingTools.join(',')}@${m.endTime ?? ''}`;
          if (sig === w.notifiedWaiting) continue;
          w.notifiedWaiting = sig;
          if (!cfg.onWaiting || quiet) continue;
          const tool = m.pendingTools[m.pendingTools.length - 1];
          void this.show(
            `⏳ ${summary.title}: waiting on ${tool} for ${Math.round(idle / 1000)}s (permission prompt or long-running tool)`,
            filePath,
          );
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async show(message: string, filePath: string): Promise<void> {
    const pick = await vscode.window.showInformationMessage(`AgentWatch: ${message}`, 'Open Session', 'Conversation');
    if (pick === 'Open Session') await vscode.commands.executeCommand('agentwatch.openSession', filePath);
    if (pick === 'Conversation') await vscode.commands.executeCommand('agentwatch.viewConversation', filePath);
  }

  /** True for a top-level session transcript (Claude `<project>/<id>.jsonl` or a Codex rollout). */
  static isMainTranscript(fsPath: string, claudeRoot: string): boolean {
    const rel = path.relative(claudeRoot, fsPath);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).length === 2;
    return /^rollout-.+\.jsonl$/i.test(path.basename(fsPath));
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
