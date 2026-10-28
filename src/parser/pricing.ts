// Cost estimates from token usage. No vscode dependency.
import { ModelUsage, TokenUsage } from './types';

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  /** 5-minute cache write; defaults to 1.25x input. */
  cacheWrite?: number;
  /** 1-hour cache write; defaults to 2x input. */
  cacheWrite1h?: number;
  /** Defaults to 0.1x input. */
  cacheRead?: number;
}

export type PriceTable = Record<string, ModelPrice>;

/**
 * First-party Claude API list prices, keyed by model id prefix (longest prefix wins).
 * Users can override or extend this with the `agentwatch.pricing` setting.
 */
export const DEFAULT_PRICES: Readonly<PriceTable> = Object.freeze({
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-3-7-sonnet': { input: 3, output: 15 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-opus': { input: 15, output: 75 },
  'claude-3-haiku': { input: 0.25, output: 1.25, cacheRead: 0.03 },
});

function validPrice(v: unknown): ModelPrice | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const p = v as Record<string, unknown>;
  const ok = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  if (!ok(p.input) || !ok(p.output)) return undefined;
  return {
    input: p.input as number,
    output: p.output as number,
    cacheWrite: ok(p.cacheWrite) ? (p.cacheWrite as number) : undefined,
    cacheWrite1h: ok(p.cacheWrite1h) ? (p.cacheWrite1h as number) : undefined,
    cacheRead: ok(p.cacheRead) ? (p.cacheRead as number) : undefined,
  };
}

/** Resolves model ids to prices and computes costs. */
export class Pricing {
  private readonly table: Array<[string, ModelPrice]>;

  /** `overrides` comes from user settings and is validated entry by entry. */
  constructor(overrides: unknown = {}) {
    const merged = new Map<string, ModelPrice>(Object.entries(DEFAULT_PRICES));
    if (typeof overrides === 'object' && overrides !== null) {
      for (const [k, v] of Object.entries(overrides)) {
        const p = validPrice(v);
        if (p && k) merged.set(k.toLowerCase(), p);
      }
    }
    this.table = [...merged.entries()].sort((a, b) => b[0].length - a[0].length);
  }

  /**
   * Price for a model id, or undefined if unknown. Handles provider prefixes and suffixes such as
   * `us.anthropic.claude-...`, `claude-...@2025...` and `claude-...[1m]`.
   */
  priceFor(model: string): ModelPrice | undefined {
    const id = model.toLowerCase();
    const at = id.indexOf('claude-');
    const bare = at > 0 ? id.slice(at) : id;
    for (const [prefix, price] of this.table) {
      if (bare.startsWith(prefix) || id.startsWith(prefix)) return price;
    }
    return undefined;
  }

  /** USD cost of `usage` on `model`; 0 for unknown models. */
  cost(model: string, usage: TokenUsage): number {
    const p = this.priceFor(model);
    if (!p) return 0;
    const cw = p.cacheWrite ?? p.input * 1.25;
    const cw1h = p.cacheWrite1h ?? p.input * 2;
    const cr = p.cacheRead ?? p.input * 0.1;
    const long = Math.min(usage.cacheWrite1h ?? 0, usage.cacheWrite);
    return (usage.input * p.input + usage.output * p.output + (usage.cacheWrite - long) * cw + long * cw1h + usage.cacheRead * cr) / 1e6;
  }

  /** Total cost across a per-model usage map. */
  costByModel(byModel: Record<string, TokenUsage | ModelUsage>): number {
    let total = 0;
    for (const [model, u] of Object.entries(byModel)) total += this.cost(model, u);
    return total;
  }

  /** Models with usage but no known price (their cost counts as 0). */
  unpriced(byModel: Record<string, TokenUsage>): string[] {
    return Object.entries(byModel)
      .filter(([m, u]) => m !== '<synthetic>' && m !== '(unknown)' && u.input + u.output + u.cacheWrite + u.cacheRead > 0)
      .map(([m]) => m)
      .filter((m) => !this.priceFor(m));
  }
}

/** Share of prompt tokens served from cache: cacheRead / (input + cacheWrite + cacheRead). */
export function cacheHitRate(u: TokenUsage): number | undefined {
  const prompt = u.input + u.cacheWrite + u.cacheRead;
  return prompt > 0 ? u.cacheRead / prompt : undefined;
}

export function formatUsd(v: number): string {
  if (!Number.isFinite(v)) return '$0';
  if (v === 0) return '$0';
  if (v < 0.01) return '<$0.01';
  if (v < 100) return '$' + v.toFixed(2);
  return '$' + Math.round(v).toLocaleString('en-US');
}

export function formatPercent(v: number | undefined): string {
  return v === undefined ? '-' : (v * 100).toFixed(1) + '%';
}
