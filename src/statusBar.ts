import * as vscode from 'vscode';
import { formatRelativeTime, formatTokens, totalTokens } from './parser/format';
import { formatUsd, Pricing } from './parser/pricing';
import { ProjectInfo, SessionFileInfo, SessionStore } from './parser/store';
import { SessionSummary } from './parser/types';

/** Shows tokens and cost of the most recent session belonging to the current workspace. */
export class TokenStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private updateSeq = 0;

  constructor(
    private readonly store: SessionStore,
    private readonly getProjects: () => Promise<ProjectInfo[]>,
    private readonly matchesWorkspace: (dirName: string, cwd: string | undefined) => boolean,
    private readonly getPricing: () => Pricing,
    private readonly isLive: (mtimeMs: number) => boolean,
    /** Called with the summary shown, e.g. for budget checks. */
    private readonly onUpdated: (info: SessionFileInfo, summary: SessionSummary) => void = () => undefined,
  ) {}

  async update(): Promise<void> {
    const seq = ++this.updateSeq;
    const cfg = vscode.workspace.getConfiguration('agentwatch');
    if (!cfg.get<boolean>('statusBar.enabled', true) || !vscode.workspace.workspaceFolders?.length) {
      this.item.hide();
      return;
    }
    try {
      const latest = await this.findLatest();
      if (seq !== this.updateSeq) return;
      if (!latest) {
        this.item.hide();
        return;
      }
      const summary = await this.store.getSummary(latest);
      if (seq !== this.updateSeq) return;
      const cost = this.getPricing().costByModel(summary.totalByModel);
      const live = cfg.get<boolean>('live.enabled', true) && this.isLive(latest.mtimeMs);
      const showCost = cfg.get<boolean>('statusBar.showCost', true);
      const running = live ? summary.main.pendingTools[summary.main.pendingTools.length - 1] : undefined;
      this.item.text =
        `$(${live ? 'sync~spin' : 'pulse'}) ${formatTokens(totalTokens(summary.totalUsage))} tok` +
        (showCost ? ` · ${formatUsd(cost)}` : '') +
        (running ? ` · ${running}` : '');
      this.item.tooltip =
        `AgentWatch: ${summary.title}\n${live ? 'running · ' : ''}${formatRelativeTime(latest.mtimeMs)} · ` +
        `${summary.agentCount} subagents · ${summary.totalToolCalls} tool calls · ≈${formatUsd(cost)}` +
        (running ? `\nWaiting on: ${summary.main.pendingTools.join(', ')}` : '');
      this.item.command = { command: 'agentwatch.openSession', title: 'Open Session', arguments: [latest.filePath] };
      this.item.show();
      this.onUpdated(latest, summary);
    } catch {
      if (seq === this.updateSeq) this.item.hide();
    }
  }

  private async findLatest(): Promise<SessionFileInfo | undefined> {
    let best: SessionFileInfo | undefined;
    for (const p of await this.getProjects()) {
      if (best && p.latestMtimeMs <= best.mtimeMs) continue;
      const cwd = (await this.store.peek(p.sessions[0])).cwd;
      if (this.matchesWorkspace(p.dirName, cwd)) best = p.sessions[0];
    }
    return best;
  }

  dispose(): void {
    this.item.dispose();
  }
}
