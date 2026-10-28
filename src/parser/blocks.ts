// 5-hour usage blocks (the window Claude subscription limits reset on). No vscode dependency.
import { addUsage, emptyUsage, totalTokens } from './format';
import { Pricing } from './pricing';
import { ModelUsage, TokenUsage } from './types';

export const BLOCK_HOURS = 5;
const HOUR_MS = 3600_000;

export interface UsageBlock {
  /** Start of the block (floored to the hour of its first activity), epoch ms. */
  start: number;
  end: number;
  usage: TokenUsage;
  cost: number;
  /** Epoch ms of the last hour bucket with activity. */
  lastActivity: number;
  active: boolean;
  /** Cost per hour since the block started (active blocks only). */
  burnRateUsd?: number;
  projectedCost?: number;
}

/**
 * Group hourly usage (keys `YYYY-MM-DDTHH`, UTC) into 5-hour blocks: a block starts at the hour of
 * the first activity after the previous block ended. Hour granularity means block starts are floored
 * to the hour, like Claude's own windows.
 */
export function computeBlocks(byHour: Record<string, Record<string, ModelUsage>>, pricing: Pricing, now = Date.now()): UsageBlock[] {
  const hours = Object.keys(byHour)
    .map((h) => ({ h, t: Date.parse(h + ':00:00Z') }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  const blocks: UsageBlock[] = [];
  let cur: UsageBlock | undefined;
  for (const { h, t } of hours) {
    const models = byHour[h];
    let tokens = 0;
    for (const u of Object.values(models)) tokens += totalTokens(u);
    if (tokens === 0) continue;
    if (!cur || t >= cur.end) {
      cur = { start: t, end: t + BLOCK_HOURS * HOUR_MS, usage: emptyUsage(), cost: 0, lastActivity: t, active: false };
      blocks.push(cur);
    }
    for (const [model, u] of Object.entries(models)) {
      addUsage(cur.usage, u);
      cur.cost += pricing.cost(model, u);
    }
    cur.lastActivity = t;
  }
  const last = blocks[blocks.length - 1];
  if (last && now < last.end && now >= last.start) {
    last.active = true;
    const elapsedH = Math.max((now - last.start) / HOUR_MS, 0.25);
    last.burnRateUsd = last.cost / elapsedH;
    last.projectedCost = last.burnRateUsd * BLOCK_HOURS;
  }
  return blocks;
}

/** Merge several per-hour maps (one per session). */
export function mergeHours(maps: Array<Record<string, Record<string, ModelUsage>>>): Record<string, Record<string, ModelUsage>> {
  const out: Record<string, Record<string, ModelUsage>> = Object.create(null);
  for (const m of maps) {
    for (const [h, models] of Object.entries(m)) {
      const d = (out[h] ??= Object.create(null) as Record<string, ModelUsage>);
      for (const [model, u] of Object.entries(models)) {
        const x = (d[model] ??= { ...emptyUsage(), messages: 0 });
        addUsage(x, u);
        x.messages += u.messages;
      }
    }
  }
  return out;
}
