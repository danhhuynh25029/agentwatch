import * as vscode from 'vscode';
import { formatRelativeTime, formatTokens, totalTokens } from './parser/format';
import { ProjectInfo, SessionFileInfo, SessionStore } from './parser/store';

/** Shows total tokens of the most recent session belonging to the current workspace. */
export class TokenStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private updateSeq = 0;

  constructor(
    private readonly store: SessionStore,
    private readonly getProjects: () => Promise<ProjectInfo[]>,
    private readonly matchesWorkspace: (dirName: string, cwd: string | undefined) => boolean,
  ) {}

  async update(): Promise<void> {
    const seq = ++this.updateSeq;
    const enabled = vscode.workspace.getConfiguration('agentwatch').get<boolean>('statusBar.enabled', true);
    if (!enabled || !vscode.workspace.workspaceFolders?.length) {
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
      this.item.text = `$(pulse) ${formatTokens(totalTokens(summary.totalUsage))} tok`;
      this.item.tooltip = `AgentWatch: ${summary.title}\n${formatRelativeTime(latest.mtimeMs)} · ${summary.agentCount} subagents · ${summary.totalToolCalls} tool calls`;
      this.item.command = { command: 'agentwatch.openSession', title: 'Open Session', arguments: [latest.filePath] };
      this.item.show();
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
