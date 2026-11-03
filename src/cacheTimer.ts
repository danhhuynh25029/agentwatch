import * as vscode from 'vscode';
import { noLinks } from './parser/format';
import { CACHE_TTL_1H_MS } from './parser/parser';
import { formatUsd, Pricing } from './parser/pricing';
import { SessionFileInfo } from './parser/store';
import { SessionSummary } from './parser/types';

const TICK_MS = 1000;
/** Keep showing "cache expired" this long after expiry, then hide. */
const SHOW_EXPIRED_MS = 10 * 60 * 1000;

interface Tracked {
  info: SessionFileInfo;
  title: string;
  touchedAt: number;
  ttlMs: number;
  /** Extra cost of re-writing the last context to the cache instead of reading it. */
  rewriteUsd?: number;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * Counts down until the prompt cache of the latest workspace session expires (each cache hit
 * refreshes it). After expiry the next message writes the whole context to the cache again.
 */
export class CacheTimer implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  private readonly timer: NodeJS.Timeout;
  private tracked: Tracked | undefined;
  private notifiedFor: number | undefined;

  constructor(private readonly getPricing: () => Pricing) {
    this.timer = setInterval(() => this.render(), TICK_MS);
  }

  /** Called with the session the token status bar shows. */
  update(info: SessionFileInfo, s: SessionSummary): void {
    const m = s.main;
    const touchedAt = m.cacheTouchedAt ? Date.parse(m.cacheTouchedAt) : NaN;
    if (!Number.isFinite(touchedAt) || !m.cacheTtlMs) {
      this.tracked = undefined;
      this.render();
      return;
    }
    const model = m.models[0];
    const context = m.context[m.context.length - 1]?.tokens ?? 0;
    let rewriteUsd: number | undefined;
    if (model && context) {
      const p = this.getPricing();
      const oneHour = m.cacheTtlMs >= CACHE_TTL_1H_MS;
      const write = p.cost(model, { input: 0, output: 0, cacheRead: 0, cacheWrite: context, ...(oneHour ? { cacheWrite1h: context } : {}) });
      const read = p.cost(model, { input: 0, output: 0, cacheWrite: 0, cacheRead: context });
      rewriteUsd = Math.max(0, write - read);
    }
    this.tracked = { info, title: s.title, touchedAt, ttlMs: m.cacheTtlMs, rewriteUsd };
    this.render();
  }

  private config() {
    const c = vscode.workspace.getConfiguration('agentwatch');
    return {
      show: c.get<boolean>('statusBar.enabled', true) && c.get<boolean>('statusBar.showCacheTimer', true),
      notify: c.get<boolean>('notify.cacheExpiry', true),
      warnMs: Math.max(10, c.get<number>('notify.cacheExpirySeconds', 60)) * 1000,
      onlyWhenUnfocused: c.get<boolean>('notify.onlyWhenUnfocused', true),
    };
  }

  private render(): void {
    const t = this.tracked;
    const cfg = this.config();
    if (!t || !cfg.show) {
      this.item.hide();
      return;
    }
    const expiresAt = t.touchedAt + t.ttlMs;
    const left = expiresAt - Date.now();
    if (left < -SHOW_EXPIRED_MS) {
      this.item.hide();
      return;
    }
    const ttl = t.ttlMs >= CACHE_TTL_1H_MS ? '1-hour' : '5-minute';
    const cost = t.rewriteUsd !== undefined ? ` (≈${formatUsd(t.rewriteUsd)} more than a cache hit)` : '';
    if (left > 0) {
      this.item.text = `$(clock) cache ${clock(left)}`;
      this.item.tooltip = `AgentWatch: the prompt cache of "${t.title}" (${ttl} TTL) expires at ${new Date(expiresAt).toLocaleTimeString()}.\nSend the next message before then to keep it; after that the whole context is written to the cache again${cost}.`;
      this.item.backgroundColor = left <= cfg.warnMs ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      if (cfg.notify && left <= cfg.warnMs && this.notifiedFor !== t.touchedAt) {
        this.notifiedFor = t.touchedAt;
        if (!(cfg.onlyWhenUnfocused && vscode.window.state.focused)) {
          void vscode.window
            .showInformationMessage(noLinks(`AgentWatch: the prompt cache of "${t.title}" expires in ${clock(left)}${cost}.`), 'Open Session')
            .then((pick) => pick && vscode.commands.executeCommand('agentwatch.openSession', t.info.filePath));
        }
      }
    } else {
      this.item.text = '$(clock) cache expired';
      this.item.tooltip = `AgentWatch: the prompt cache of "${t.title}" expired at ${new Date(expiresAt).toLocaleTimeString()}. The next message writes the whole context to the cache again${cost}.`;
      this.item.backgroundColor = undefined;
    }
    this.item.command = { command: 'agentwatch.openSession', title: 'Open Session', arguments: [t.info.filePath] };
    this.item.show();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.item.dispose();
  }
}
