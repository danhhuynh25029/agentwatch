import * as vscode from 'vscode';
import { computeBlocks, mergeHours, UsageBlock } from './parser/blocks';
import { formatTokens, totalTokens } from './parser/format';
import { mapPool } from './parser/parser';
import { formatUsd, Pricing } from './parser/pricing';
import { SessionFileInfo, SessionStore } from './parser/store';

/** Sessions modified within this window feed the block computation. */
const LOOKBACK_MS = 24 * 3600_000;

/** Tracks 5-hour usage blocks across all projects and shows the active one in the status bar. */
export class BlockTracker implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  private seq = 0;

  constructor(
    private readonly store: SessionStore,
    private readonly allSessions: () => Promise<SessionFileInfo[]>,
    private readonly getPricing: () => Pricing,
  ) {
    this.item.command = 'agentwatch.openDashboard';
  }

  tokenLimit(): number | undefined {
    const v = vscode.workspace.getConfiguration('agentwatch').get<number>('blocks.tokenLimit', 0);
    return typeof v === 'number' && v > 0 ? v : undefined;
  }

  /** All blocks from sessions active in the last 24 hours, oldest first. */
  async compute(): Promise<UsageBlock[]> {
    const since = Date.now() - LOOKBACK_MS;
    const sessions = (await this.allSessions()).filter((s) => s.mtimeMs >= since);
    const hours = await mapPool(sessions, 4, async (s) => {
      try {
        return (await this.store.getSummary(s)).totalByHour;
      } catch {
        return {};
      }
    });
    return computeBlocks(mergeHours(hours), this.getPricing());
  }

  async update(): Promise<void> {
    const seq = ++this.seq;
    if (!vscode.workspace.getConfiguration('agentwatch').get<boolean>('statusBar.showBlock', true)) {
      this.item.hide();
      return;
    }
    try {
      const blocks = await this.compute();
      if (seq !== this.seq) return;
      const cur = blocks.find((b) => b.active);
      if (!cur) {
        this.item.hide();
        return;
      }
      const tokens = totalTokens(cur.usage);
      const limit = this.tokenLimit();
      const mins = Math.max(0, Math.round((cur.end - Date.now()) / 60000));
      const left = `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}`;
      this.item.text = `$(clock) ${limit ? Math.round((tokens / limit) * 100) + '%' : formatTokens(tokens)} · ${left}`;
      this.item.tooltip =
        `AgentWatch: current 5-hour block (all projects)\n` +
        `${formatTokens(tokens)} tokens${limit ? ` of ${formatTokens(limit)}` : ''} · ≈${formatUsd(cur.cost)}\n` +
        `Burn rate ≈${formatUsd(cur.burnRateUsd ?? 0)}/h · projected ≈${formatUsd(cur.projectedCost ?? 0)}\n` +
        `Resets at ${new Date(cur.end).toLocaleTimeString()}`;
      this.item.backgroundColor =
        limit && tokens >= limit * 0.9 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      this.item.show();
    } catch {
      if (seq === this.seq) this.item.hide();
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
