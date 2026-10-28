import * as vscode from 'vscode';
import { sessionCostOnDay } from './parser/aggregate';
import { mapPool, localDay } from './parser/parser';
import { formatUsd, Pricing } from './parser/pricing';
import { SessionFileInfo, SessionStore } from './parser/store';
import { SessionSummary } from './parser/types';
import { sinceMs } from './filter';

const NOTIFIED_KEY = 'agentwatch.budgetNotified';
const DAILY_CHECK_INTERVAL_MS = 60_000;

/**
 * Warns once when a session or the day's total crosses the configured USD budget
 * (`agentwatch.budget.sessionUsd`, `agentwatch.budget.dailyUsd`; 0 disables).
 */
export class BudgetMonitor {
  private lastDailyCheck = 0;
  private dailyRunning = false;

  constructor(
    private readonly state: vscode.Memento,
    private readonly store: SessionStore,
    /** Every Claude and Codex session. */
    private readonly allSessions: () => Promise<SessionFileInfo[]>,
    private readonly getPricing: () => Pricing,
  ) {}

  private budgets(): { session: number; daily: number } {
    const cfg = vscode.workspace.getConfiguration('agentwatch');
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    return { session: num(cfg.get('budget.sessionUsd')), daily: num(cfg.get('budget.dailyUsd')) };
  }

  /** Records `key` as notified; returns false if it already was. */
  private async markOnce(key: string): Promise<boolean> {
    const done = this.state.get<string[]>(NOTIFIED_KEY, []);
    if (done.includes(key)) return false;
    // Keep the list short: only the most recent keys matter.
    await this.state.update(NOTIFIED_KEY, [...done.slice(-200), key]);
    return true;
  }

  /** Check the session just shown in the status bar, and (rate-limited) today's total. */
  check(info: SessionFileInfo, summary: SessionSummary): void {
    const { session, daily } = this.budgets();
    if (session) {
      const cost = this.getPricing().costByModel(summary.totalByModel);
      if (cost >= session) {
        void this.markOnce(`session:${info.sessionId}:${session}`).then((first) => {
          if (!first) return;
          void vscode.window
            .showWarningMessage(
              `AgentWatch: session "${summary.title}" has reached ≈${formatUsd(cost)} (budget ${formatUsd(session)}).`,
              'Open Session',
            )
            .then((pick) => pick && vscode.commands.executeCommand('agentwatch.openSession', info.filePath));
        });
      }
    }
    if (daily && Date.now() - this.lastDailyCheck >= DAILY_CHECK_INTERVAL_MS && !this.dailyRunning) {
      this.lastDailyCheck = Date.now();
      this.dailyRunning = true;
      void this.checkDaily(daily).finally(() => (this.dailyRunning = false));
    }
  }

  /** Sum of today's cost across all sessions modified today (every project, not only the workspace). */
  async todayCost(): Promise<number> {
    const today = localDay(Date.now());
    const start = sinceMs(0);
    const sessions = (await this.allSessions()).filter((s) => s.mtimeMs >= start);
    const costs = await mapPool(sessions, 4, async (s) => {
      try {
        return sessionCostOnDay(await this.store.getSummary(s), today, this.getPricing());
      } catch {
        return 0;
      }
    });
    return costs.reduce((a, b) => a + b, 0);
  }

  private async checkDaily(daily: number): Promise<void> {
    const cost = await this.todayCost();
    if (cost < daily) return;
    if (!(await this.markOnce(`daily:${localDay(Date.now())}:${daily}`))) return;
    const pick = await vscode.window.showWarningMessage(
      `AgentWatch: today's Claude Code usage is ≈${formatUsd(cost)} (daily budget ${formatUsd(daily)}).`,
      'Open Dashboard',
    );
    if (pick) await vscode.commands.executeCommand('agentwatch.openDashboard');
  }
}
