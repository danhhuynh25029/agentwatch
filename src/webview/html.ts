// Shared HTML helpers for webviews (no vscode dependency, unit-testable).
// Everything coming from transcripts is untrusted and must go through esc().
// The CSP forbids inline style attributes: all styling goes through classes in STYLE.
import { formatTokens } from '../parser/format';

export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function n(v: number): string {
  return esc(v.toLocaleString('en-US'));
}

export function tok(v: number): string {
  return `<span title="${n(v)}">${esc(formatTokens(v))}</span>`;
}

export function time(iso: string | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? esc(iso) : esc(d.toLocaleString());
}

export function table(headers: string[], rows: string[], numericFrom = 1): string {
  if (rows.length === 0) return '<div class="empty">Nothing here</div>';
  const th = headers.map((h, i) => `<th class="${i >= numericFrom ? 'num' : ''}">${esc(h)}</th>`).join('');
  return `<div class="tbl"><table><thead><tr>${th}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

export type Tone = 'blue' | 'green' | 'purple' | 'orange' | 'red' | 'teal';

export interface Kpi {
  label: string;
  /** Trusted HTML (already escaped). */
  value: string;
  /** Trusted HTML shown under the value. */
  sub?: string;
  tone?: Tone;
  icon?: string;
}

export function kpis(items: Kpi[], caption = ''): string {
  return `${caption ? `<div class="caption">${esc(caption)}</div>` : ''}<div class="kpis">${items
    .map(
      (k) =>
        `<div class="kpi tone-${k.tone ?? 'blue'}"><div class="kpi-label">${k.icon ? `<span class="kpi-icon">${esc(k.icon)}</span>` : ''}${esc(k.label)}</div><div class="kpi-value">${k.value}</div>${
          k.sub ? `<div class="kpi-sub">${k.sub}</div>` : ''
        }</div>`,
    )
    .join('')}</div>`;
}

/**
 * Specimen figures: an optional lead figure at display size, then a row of figures,
 * then an optional line of small facts. Hierarchy comes from size and weight, not boxes.
 */
export function figures(lead: Kpi | undefined, items: Kpi[], small: string[] = []): string {
  const fig = (k: Kpi, cls = '') =>
    `<div class="fig${cls}"><div class="fig-label">${esc(k.label)}</div><div class="fig-value">${k.value}</div>${k.sub ? `<div class="fig-sub">${k.sub}</div>` : ''}</div>`;
  return `<div class="figs">${lead ? fig(lead, ' fig-lead') : ''}${items.map((k) => fig(k)).join('')}</div>${
    small.length ? `<div class="figs-sm">${small.map((x) => `<span>${x}</span>`).join('')}</div>` : ''
  }`;
}

/** Weight class for a share of the total (0..1): the larger the share, the heavier the figure. */
export function weightClass(fraction: number): string {
  const f = Number.isFinite(fraction) ? fraction : 0;
  return f >= 0.5 ? 'w5' : f >= 0.2 ? 'w4' : f >= 0.06 ? 'w3' : f >= 0.015 ? 'w2' : 'w1';
}

/** Trusted HTML wrapped in its weight class. */
export function weighted(html: string, fraction: number): string {
  return `<span class="${weightClass(fraction)}">${html}</span>`;
}

const CARD_TONES: Tone[] = ['blue', 'purple', 'teal', 'orange', 'green', 'red'];

/** Simple KPI row from [label, html] pairs (tones cycle). */
export function cardRow(label: string, items: Array<[string, string]>): string {
  return kpis(items.map(([k, v], i) => ({ label: k, value: v, tone: CARD_TONES[i % CARD_TONES.length] })), label);
}

export function chip(text: string, opts: { tone?: Tone; icon?: string; title?: string; mono?: boolean } = {}): string {
  const title = opts.title ? ` title="${esc(opts.title)}"` : '';
  return `<span class="chip${opts.tone ? ' tone-' + opts.tone : ''}${opts.mono ? ' mono' : ''}"${title}>${opts.icon ? `<span class="chip-icon">${esc(opts.icon)}</span>` : ''}${esc(text)}</span>`;
}

/** Small status pill: ok / err / warn / info / live. */
export function pill(text: string, kind: 'ok' | 'err' | 'warn' | 'info' | 'live' | 'muted' = 'info'): string {
  return `<span class="pill pill-${kind}">${esc(text)}</span>`;
}

export function statusPill(status: string | undefined): string {
  if (!status) return '<span class="muted">-</span>';
  const s = status.toLowerCase();
  const kind = /error|fail|kill/.test(s) ? 'err' : /complete|done|success/.test(s) ? 'ok' : /launch|running|progress/.test(s) ? 'live' : 'info';
  return pill(status, kind);
}

/** Card section with header; collapsible when `collapsible` is set. */
export function section(
  id: string,
  title: string,
  body: string,
  opts: { icon?: string; count?: number; subtitle?: string; collapsible?: boolean; open?: boolean; wide?: boolean } = {},
): string {
  const head = `<span class="sec-title">${opts.icon ? `<span class="sec-icon">${esc(opts.icon)}</span>` : ''}${esc(title)}${
    opts.count !== undefined ? `<span class="count">${n(opts.count)}</span>` : ''
  }</span>${opts.subtitle ? `<span class="sec-sub">${esc(opts.subtitle)}</span>` : ''}`;
  if (opts.collapsible) {
    return `<details class="card" id="${esc(id)}"${opts.open === false ? '' : ' open'}><summary class="sec-head">${head}<span class="chev">›</span></summary><div class="sec-body">${body}</div></details>`;
  }
  return `<section class="card" id="${esc(id)}"><div class="sec-head">${head}</div><div class="sec-body">${body}</div></section>`;
}

/** Sticky in-page navigation. */
export function nav(links: Array<[id: string, label: string]>): string {
  return `<nav class="nav">${links.map(([id, label]) => `<a href="#${esc(id)}">${esc(label)}</a>`).join('')}</nav>`;
}

export interface HeroOptions {
  title: string;
  /** Trusted HTML: chips row. */
  meta?: string;
  /** Trusted HTML: action buttons. */
  actions?: string;
  /** Trusted HTML under the title. */
  extra?: string;
}

export function hero(o: HeroOptions): string {
  return `<header class="hero"><h1>${esc(o.title)}</h1>${
    o.meta ? `<div class="chips">${o.meta}</div>` : ''
  }${o.extra ?? ''}${o.actions ? `<div class="toolbar">${o.actions}</div>` : ''}</header>`;
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'link';

/** Action button; the webview only ever sends `{command, index}`, never a path. */
export function action(
  command: string,
  label: string,
  opts: { index?: number; link?: boolean; title?: string; variant?: ButtonVariant; icon?: string } = {},
): string {
  const idx = opts.index !== undefined ? ` data-index="${opts.index}"` : '';
  const variant = opts.link ? 'link' : opts.variant ?? 'secondary';
  const title = opts.title ? ` title="${esc(opts.title)}"` : '';
  const icon = opts.icon ? `<span class="btn-icon">${esc(opts.icon)}</span>` : '';
  return `<button class="btn btn-${variant}" data-action="${esc(command)}"${idx}${title}>${icon}${esc(label)}</button>`;
}

/** Horizontal share bar (0..1) using <meter>, since inline widths are blocked by the CSP. */
export function shareBar(fraction: number, tone: Tone = 'blue'): string {
  const v = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return `<meter class="share tone-${tone}" min="0" max="1" value="${v.toFixed(3)}"></meter>`;
}

export interface ChartPoint {
  x: number;
  y: number;
  /** Tooltip text (escaped here). */
  title?: string;
}

const CHART_W = 800;
const CHART_H = 180;
const PAD = 6;

function gridLines(): string {
  return [0.25, 0.5, 0.75]
    .map((f) => `<line class="grid" x1="0" x2="${CHART_W}" y1="${(PAD + f * (CHART_H - 2 * PAD)).toFixed(1)}" y2="${(PAD + f * (CHART_H - 2 * PAD)).toFixed(1)}"/>`)
    .join('');
}

function yAxis(maxY: number, fmt: (v: number) => string): string {
  return `<div class="y-axis"><span>${esc(fmt(maxY))}</span><span>${esc(fmt(maxY / 2))}</span><span>0</span></div>`;
}

/** Area chart as inline SVG; `markers` are x positions drawn as dashed vertical lines. */
export function lineChart(points: ChartPoint[], markers: ChartPoint[] = [], yLabel = formatTokens): string {
  if (points.length === 0) return '<div class="empty">No data</div>';
  return `<div class="chart">${lineSvg(points, markers, yLabel)}</div>`;
}

export interface ScrubPoint extends ChartPoint {
  /** Readout text for this point (escaped here). */
  value: string;
  /** Secondary readout text, e.g. message number and time (escaped here). */
  meta: string;
}

/**
 * Line chart with a range scrubber: moving the slider re-sets the readout figure and the
 * marker to that point. The series rides as a data attribute; the script only sets text
 * and SVG attributes (inline styles are blocked by the CSP).
 */
export function scrubChart(points: ScrubPoint[], markers: ChartPoint[] = [], yLabel = formatTokens, start = points.length - 1): string {
  if (points.length === 0) return '<div class="empty">No data</div>';
  const { sx, sy } = chartScales(points);
  const at = Math.max(0, Math.min(start, points.length - 1));
  const series = JSON.stringify(points.map((p) => [Number(sx(p.x).toFixed(1)), Number(sy(p.y).toFixed(1)), p.value, p.meta]));
  const p = points[at];
  const x = sx(p.x).toFixed(1);
  const overlay = `<line class="scrub-line" data-scrub-line x1="${x}" x2="${x}" y1="0" y2="${CHART_H}"/><circle class="scrub-dot" data-scrub-dot r="4.5" cx="${x}" cy="${sy(p.y).toFixed(1)}"/>`;
  return `<div class="scrubber" data-series="${esc(series)}"><div class="scrub-read"><span class="fig-value" data-scrub-value>${esc(p.value)}</span><span class="scrub-meta" data-scrub-meta>${esc(
    p.meta,
  )}</span></div><div class="chart">${lineSvg(points, markers, yLabel, overlay)}</div><input class="scrub" type="range" min="0" max="${points.length - 1}" value="${at}" aria-label="Scrub through the session"></div>`;
}

function chartScales(points: ChartPoint[]): { sx: (x: number) => number; sy: (y: number) => number; maxY: number } {
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const maxY = Math.max(1, ...points.map((p) => p.y)) * 1.08;
  const spanX = maxX - minX || 1;
  return {
    sx: (x: number) => PAD + ((x - minX) / spanX) * (CHART_W - 2 * PAD),
    sy: (y: number) => CHART_H - PAD - (y / maxY) * (CHART_H - 2 * PAD),
    maxY,
  };
}

function lineSvg(points: ChartPoint[], markers: ChartPoint[], yLabel: (v: number) => string, overlay = ''): string {
  const { sx, sy, maxY } = chartScales(points);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const area = `${line} L${sx(points[points.length - 1].x).toFixed(1)},${CHART_H - PAD} L${sx(points[0].x).toFixed(1)},${CHART_H - PAD} Z`;
  const marks = markers
    .map((m) => `<line class="chart-marker" x1="${sx(m.x).toFixed(1)}" x2="${sx(m.x).toFixed(1)}" y1="0" y2="${CHART_H}"><title>${esc(m.title ?? '')}</title></line>`)
    .join('');
  const dots = points
    .map((p) => `<circle class="chart-dot" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="4"><title>${esc(p.title ?? '')}</title></circle>`)
    .join('');
  return `${yAxis(maxY, yLabel)}<svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" role="img">${gridLines()}<path class="chart-area" d="${area}"/>${marks}<path class="chart-line" d="${line}"/>${dots}${overlay}</svg>`;
}

/** Vertical bar chart as inline SVG, one bar per value. */
export function barChart(values: ChartPoint[], yLabel: (v: number) => string, tone: Tone = 'blue'): string {
  if (values.length === 0) return '<div class="empty">No data</div>';
  const maxY = Math.max(1e-9, ...values.map((v) => v.y)) * 1.08;
  const w = (CHART_W - 2 * PAD) / values.length;
  const bars = values
    .map((v, i) => {
      const h = (v.y / maxY) * (CHART_H - 2 * PAD);
      const x = PAD + i * w;
      return `<rect class="chart-bar" rx="1" x="${(x + w * 0.15).toFixed(1)}" y="${(CHART_H - PAD - h).toFixed(1)}" width="${(w * 0.7).toFixed(1)}" height="${Math.max(h, 0).toFixed(1)}"><title>${esc(v.title ?? '')}</title></rect>`;
    })
    .join('');
  return `<div class="chart tone-${tone}">${yAxis(maxY, yLabel)}<svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" role="img">${gridLines()}${bars}</svg></div>`;
}

export interface GanttRow {
  label: string;
  start: number;
  end: number;
  title: string;
  error?: boolean;
  depth?: number;
}

/** Horizontal timeline (one bar per row) as inline SVG. Times are epoch ms. */
export function ganttChart(rows: GanttRow[], t0: number, t1: number): string {
  if (rows.length === 0 || !(t1 > t0)) return '<div class="empty">No timing data</div>';
  const rowH = 24;
  const labelW = 240;
  const w = CHART_W;
  const h = rows.length * rowH + 6;
  const sx = (t: number) => labelW + ((t - t0) / (t1 - t0)) * (w - labelW - PAD);
  const bars = rows
    .map((r, i) => {
      const x = sx(Math.max(r.start, t0));
      const bw = Math.max(sx(Math.min(r.end, t1)) - x, 3);
      const y = i * rowH + 4;
      const label = (r.depth && r.depth > 1 ? '  '.repeat(r.depth - 1) + '↳ ' : '') + r.label;
      return `<rect class="gantt-track" x="${labelW}" y="${y}" width="${w - labelW - PAD}" height="${rowH - 8}" rx="4"/><text class="gantt-label" x="4" y="${y + 12}">${esc(
        label.length > 36 ? label.slice(0, 35) + '…' : label,
      )}</text><rect class="gantt-bar${r.error ? ' error' : ''}" rx="4" x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${rowH - 8}"><title>${esc(r.title)}</title></rect>`;
    })
    .join('');
  return `<div class="gantt"><svg viewBox="0 0 ${w} ${h}" width="100%" role="img">${bars}</svg></div>`;
}

/** Full HTML document with a nonce-based CSP (no inline style attributes allowed). */
export function page(title: string, body: string, nonce: string, cspSource: string, extraStyle = ''): string {
  const csp = `default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${cspSource};`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style nonce="${nonce}">${STYLE}${extraStyle}</style>
</head>
<body>
<main class="wrap">
${body}
</main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

export function renderMessage(message: string, nonce: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">${STYLE}</style></head><body><div class="loading"><div class="spinner"></div><p class="muted">${esc(message)}</p></div></body></html>`;
}

export const MAX_INDENT = 8;
const INDENT_CSS = Array.from({ length: MAX_INDENT }, (_, i) => `.d${i + 1} { padding-left: ${i * 18}px; }`).join('\n');

const TONES: Record<Tone, string> = {
  blue: 'var(--vscode-charts-blue, #3794ff)',
  green: 'var(--vscode-charts-green, #89d185)',
  purple: 'var(--vscode-charts-purple, #b180d7)',
  orange: 'var(--vscode-charts-orange, #d18616)',
  red: 'var(--vscode-charts-red, #f14c4c)',
  teal: 'var(--vscode-terminal-ansiCyan, #29b8db)',
};
const TONE_CSS = Object.entries(TONES)
  .map(([t, c]) => `.tone-${t} { --tone: ${c}; }`)
  .join('\n');

export const STYLE = INDENT_CSS + '\n' + TONE_CSS + `
:root {
  --fg: var(--vscode-foreground);
  --muted: var(--vscode-descriptionForeground);
  --bg: var(--vscode-editor-background);
  /* The one foundry accent: scrubber, current nav item, focus. */
  --accent: var(--vscode-charts-orange, #d18616);
  --line: color-mix(in srgb, var(--fg) 12%, transparent);
  --line-strong: color-mix(in srgb, var(--fg) 28%, transparent);
  --surface: color-mix(in srgb, var(--fg) 4%, var(--bg));
  --hover: color-mix(in srgb, var(--fg) 5%, transparent);
  --ink: color-mix(in srgb, var(--fg) 78%, transparent);
  --faint: color-mix(in srgb, var(--fg) 10%, transparent);
  --red: var(--vscode-errorForeground, #f85149);
  --green: var(--vscode-charts-green, #89d185);
  --warn: var(--vscode-editorWarning-foreground, #cca700);
  --radius: 6px;
  --mono: var(--vscode-editor-font-family, ui-monospace, monospace);
}
body.vscode-high-contrast, body.vscode-high-contrast-light { --line: var(--vscode-contrastBorder, currentColor); --line-strong: var(--vscode-contrastBorder, currentColor); --faint: var(--vscode-contrastBorder, currentColor); }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg); background: var(--bg); line-height: 1.5; -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums; }
::selection { background: color-mix(in srgb, var(--accent) 38%, transparent); }
:focus { outline: none; }
:focus-visible { outline: 1px solid var(--vscode-focusBorder, var(--accent)); outline-offset: 2px; border-radius: 3px; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 32px 32px 96px; }
a { color: var(--fg); text-decoration: none; }
code, .mono { font-family: var(--mono); font-size: 0.92em; }
code { background: var(--hover); padding: 1px 5px; border-radius: 3px; }
h1, h2, h3, p { margin: 0; }
p + p { margin-top: 6px; }
/* Specimen labels: tiny monospace caps, the only place letter-spacing opens up. */
h3, .label, .caption, thead th, .fig-label { font-family: var(--mono); font-size: 10.5px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
h3 { margin: 32px 0 12px; }
.muted { color: var(--muted); }
.err { color: var(--red); }
.good { color: var(--green); }
.small { font-size: 12px; }
.note-text { margin-top: 12px; max-width: 72ch; }

/* Header */
.hero { padding: 0 0 8px; }
.hero h1 { font-size: 26px; font-weight: 600; letter-spacing: -0.022em; line-height: 1.2; word-break: break-word; text-wrap: balance; max-width: 36ch; }
.chips { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 16px; margin-top: 10px; color: var(--muted); font-size: 12px; }
.chip { display: inline-flex; align-items: baseline; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.chip.mono { font-family: var(--mono); font-size: 11.5px; }
td .chip, .vs .chip { color: var(--muted); }
.note { margin-top: 14px; padding-left: 12px; border-left: 1px solid var(--line-strong); color: var(--muted); white-space: pre-wrap; max-width: 72ch; }
.toolbar { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 24px; }

/* Specimen figures: hierarchy by size and weight only, no boxes. */
.figs { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 22px 28px; margin-top: 30px; }
.fig { min-width: 0; }
.fig-value { font-size: 28px; font-weight: 500; letter-spacing: -0.03em; line-height: 1.1; margin-top: 4px; white-space: nowrap; }
.fig-sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
.fig-lead { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 18px; padding-bottom: 6px; }
.fig-lead .fig-label { flex-basis: 100%; }
.fig-lead .fig-value { font-size: 64px; font-weight: 600; letter-spacing: -0.045em; line-height: 1; margin-top: 6px; }
.fig-lead .fig-sub { font-size: 13px; margin: 0; }
.figs-sm { display: flex; flex-wrap: wrap; gap: 4px 0; margin-top: 18px; color: var(--muted); font-size: 12.5px; }
.figs-sm span + span::before { content: '·'; padding: 0 9px; color: var(--line-strong); }
.figs-sm b { color: var(--fg); font-weight: 600; }

/* Weight encodes share: w1 = smallest share, w5 = largest. */
.w1 { font-weight: 300; color: var(--muted); } .w2 { font-weight: 400; } .w3 { font-weight: 500; } .w4 { font-weight: 650; } .w5 { font-weight: 800; }

/* Buttons */
.btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; border: 1px solid transparent; border-radius: var(--radius); padding: 0 12px; cursor: pointer; font: inherit; font-size: 12.5px; transition: background 0.12s ease-out, color 0.12s ease-out, border-color 0.12s ease-out; }
.btn-primary { background: var(--fg); color: var(--bg); font-weight: 600; }
.btn-primary:hover { background: color-mix(in srgb, var(--fg) 86%, var(--bg)); }
.btn-secondary { background: transparent; color: var(--fg); border-color: var(--line-strong); }
.btn-secondary:hover { background: var(--hover); border-color: var(--fg); }
.btn-ghost { background: transparent; color: var(--muted); }
.btn-ghost:hover { color: var(--fg); background: var(--hover); }
.btn-link { height: auto; background: none; border: none; padding: 0; color: var(--fg); text-align: left; word-break: break-word; text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 3px; }
.btn-link:hover { text-decoration-color: var(--accent); }
.btn:disabled { opacity: 0.45; cursor: default; }
.btn-icon { opacity: 0.8; }

/* Navigation */
.nav { position: sticky; top: 0; z-index: 5; display: flex; gap: 2px 18px; flex-wrap: wrap; margin: 20px 0 0; padding-top: 2px; border-bottom: 1px solid var(--line); background: var(--bg); }
.nav a { padding: 10px 0 9px; color: var(--muted); font-size: 12.5px; border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color 0.12s ease-out, border-color 0.12s ease-out; }
.nav a:hover { color: var(--fg); }
.nav a[aria-current="true"] { color: var(--fg); border-bottom-color: var(--accent); }

/* Legacy KPI rows render as specimen figures too. */
.caption { margin: 30px 0 4px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 18px 28px; margin-top: 10px; }
.kpi { min-width: 0; }
.kpi-label { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.kpi-value { font-size: 24px; font-weight: 500; letter-spacing: -0.03em; line-height: 1.15; margin-top: 4px; white-space: nowrap; }
.kpi-sub { color: var(--muted); font-size: 12px; margin-top: 3px; }
.kpi-sub .err { color: var(--red); }

/* Sections */
.card { margin: 0; padding: 0 0 8px; scroll-margin-top: 48px; }
.sec-head { display: flex; align-items: baseline; gap: 12px; padding: 48px 0 4px; list-style: none; }
.nav + .card > .sec-head { padding-top: 32px; }
details.card > summary { cursor: pointer; user-select: none; }
details.card > summary::-webkit-details-marker { display: none; }
details.card > summary:hover .sec-title { color: color-mix(in srgb, var(--fg) 80%, var(--bg)); }
.chev { margin-left: auto; transition: transform 0.15s ease-out; color: var(--muted); font-size: 18px; line-height: 1; }
details.card[open] .chev { transform: rotate(90deg); }
.sec-title { font-size: 22px; font-weight: 600; letter-spacing: -0.025em; display: inline-flex; align-items: baseline; gap: 10px; }
.sec-icon { display: none; }
.sec-sub { color: var(--muted); font-size: 12.5px; }
.count { font-family: var(--mono); font-size: 12px; font-weight: 400; color: var(--muted); letter-spacing: 0; }
.sec-body { padding: 10px 0 8px; }
.sec-body > :is(.caption, h3):first-child, .sec-body > .grid-2:first-child > div > :is(.caption, h3):first-child { margin-top: 6px; }
.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 0 40px; }
.empty { color: var(--muted); padding: 14px 0; }
.explain { color: var(--muted); font-size: 12px; margin-top: 10px; max-width: 80ch; }

/* Tables */
.tbl { overflow: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 8px 12px; vertical-align: top; }
th:first-child, td:first-child { padding-left: 0; }
th:last-child, td:last-child { padding-right: 0; }
thead th { white-space: nowrap; padding-bottom: 6px; border-bottom: 1px solid var(--line-strong); }
tbody td { border-bottom: 1px solid var(--line); }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover td { background: var(--hover); }
.num { text-align: right; white-space: nowrap; }
.ts { white-space: nowrap; color: var(--muted); font-size: 12px; }
table.kv { width: auto; }
table.kv th { color: var(--muted); font-weight: 400; padding-right: 32px; font-family: inherit; text-transform: none; letter-spacing: 0; font-size: 13px; border: none; }
table.kv td { border: none; }
table.kv tr:hover td { background: none; }
.cell-strong { font-weight: 600; }

/* Pills: status words, not badges. */
.pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); white-space: nowrap; }
.pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.pill-err { color: var(--red); }
.pill-ok { color: var(--green); }
.pill-warn { color: var(--warn); }
.pill-live { color: var(--green); }
.pill-live::before { animation: blink 2s ease-in-out infinite; }
.pill-info::before, .pill-muted::before { opacity: 0.6; }
@keyframes blink { 50% { opacity: 0.25; } }

/* Share bars */
meter.share { width: 100%; min-width: 72px; height: 3px; vertical-align: middle; }
meter.share::-webkit-meter-bar { background: var(--faint); border: none; border-radius: 0; height: 3px; }
meter.share::-webkit-meter-optimum-value, meter.share::-webkit-meter-suboptimum-value, meter.share::-webkit-meter-even-less-good-value { background: var(--ink); border-radius: 0; }
meter.block-meter { margin-top: 16px; }
meter.share.tone-red::-webkit-meter-optimum-value { background: var(--red); }

/* Timeline */
ol.timeline { list-style: none; padding: 0; margin: 0; }
ol.timeline li { display: grid; grid-template-columns: minmax(150px, max-content) 1fr; gap: 0 20px; padding: 10px 0; border-bottom: 1px solid var(--line); }
ol.timeline li:last-child { border-bottom: none; }
ol.timeline .ts { padding-top: 1px; }
.pt { white-space: pre-wrap; word-break: break-word; max-width: 80ch; }

pre { white-space: pre-wrap; word-break: break-word; background: var(--surface); padding: 8px 10px; border-radius: var(--radius); margin: 4px 0; font-family: var(--mono); font-size: 12px; max-height: 260px; overflow: auto; }

/* Charts: flat ink, no gradients. */
.chart { position: relative; margin: 10px 0 4px; padding-left: 52px; }
.chart svg { width: 100%; height: 170px; display: block; overflow: visible; }
.y-axis { position: absolute; left: 0; top: 0; bottom: 0; width: 44px; display: flex; flex-direction: column; justify-content: space-between; font-family: var(--mono); font-size: 10.5px; color: var(--muted); text-align: right; }
.grid { stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
.chart-area { fill: var(--faint); stroke: none; }
.chart-line { fill: none; stroke: var(--fg); stroke-width: 1.5; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.chart-dot { fill: var(--bg); stroke: var(--fg); stroke-width: 1.5; opacity: 0; vector-effect: non-scaling-stroke; }
.chart-dot:hover { opacity: 1; }
.chart-bar { fill: var(--ink); transition: fill 0.12s ease-out; }
.chart-bar:hover { fill: var(--accent); }
.chart-marker { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
.scrub-line { stroke: var(--accent); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.scrub-dot { fill: var(--accent); stroke: var(--bg); stroke-width: 2; vector-effect: non-scaling-stroke; }
.legend { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.legend b { color: var(--fg); font-weight: 500; }
.legend .swatch-marker { color: var(--muted); }
.axis-note { display: flex; justify-content: space-between; color: var(--muted); font-family: var(--mono); font-size: 10.5px; padding-left: 52px; margin-top: 4px; }

/* Context scrubber: one range input re-sets the readout above the chart. */
.scrub-read { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; margin: 4px 0 8px; }
.scrub-read .fig-value { font-size: 44px; font-weight: 600; letter-spacing: -0.04em; margin: 0; }
.scrub-read .scrub-meta { color: var(--muted); font-size: 12.5px; }
input.scrub { -webkit-appearance: none; appearance: none; display: block; width: calc(100% - 52px); margin: 8px 0 0 52px; height: 18px; background: transparent; cursor: ew-resize; }
input.scrub::-webkit-slider-runnable-track { height: 2px; background: var(--line-strong); }
input.scrub::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: -6px; border-radius: 50%; background: var(--accent); border: 2px solid var(--bg); }
input.scrub:focus-visible { outline-offset: 4px; }

/* Gantt */
.gantt svg { display: block; }
.gantt-label { fill: var(--fg); font-size: 11.5px; font-family: var(--vscode-font-family); white-space: pre; }
.gantt-track { fill: var(--faint); }
.gantt-bar { fill: var(--ink); }
.gantt-bar.error { fill: var(--red); }

/* Insights */
.insights { display: flex; flex-direction: column; margin-top: 8px; }
.insight { display: grid; grid-template-columns: 14px 1fr; gap: 0 10px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.insight:last-child { border-bottom: none; }
.insight .ic { width: 6px; height: 6px; border-radius: 50%; margin-top: 7px; background: var(--muted); }
.insight.warn .ic { background: var(--warn); }
.insight .t { font-weight: 600; }
.insight .d { color: var(--muted); font-size: 12px; word-break: break-word; }

/* Loading */
.loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; height: 80vh; }
.spinner { width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid var(--line-strong); border-top-color: var(--fg); animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } .pill-live::before, .spinner { animation: none; } * { transition: none !important; } }
@media (max-width: 640px) {
  .wrap { padding: 22px 16px 64px; }
  .hero h1 { font-size: 22px; }
  .fig-lead .fig-value { font-size: 48px; }
  .fig-value { font-size: 24px; }
  .sec-title { font-size: 19px; }
  .sec-head { padding-top: 36px; }
  .grid-2 { grid-template-columns: 1fr; }
  .chart { padding-left: 0; } .y-axis { display: none; } .axis-note { padding-left: 0; } input.scrub { width: 100%; margin-left: 0; }
}
`;

// Sends only an action name + numeric index; the extension resolves indexes to values it rendered.
// data-toggle="cls" toggles a class on <body> (client-side only, e.g. hiding tool calls).
const SCRIPT = `
(function () {
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', function (e) {
    const t = e.target && e.target.closest ? e.target.closest('[data-action],[data-toggle],[data-replay]') : null;
    if (!t) return;
    const toggle = t.getAttribute('data-toggle');
    const replay = t.getAttribute('data-replay');
    if (replay) { onReplay(replay); return; }
    if (toggle) {
      const on = document.body.classList.toggle(toggle);
      state.toggles = Object.assign({}, state.toggles, { [toggle]: on });
      save();
      return;
    }
    const idx = t.getAttribute('data-index');
    vscode.postMessage({ command: t.getAttribute('data-action'), index: idx === null ? undefined : Number(idx) });
  });
  // Keep scroll position, collapsed sections and toggles across re-renders (live reload, refresh).
  const state = vscode.getState() || {};
  function save() { vscode.setState(state); }
  Object.keys(state.sections || {}).forEach(function (id) {
    const el = document.getElementById(id);
    if (el && el.tagName === 'DETAILS') el.open = !!state.sections[id];
  });
  Object.keys(state.toggles || {}).forEach(function (cls) {
    if (!state.toggles[cls]) return;
    document.body.classList.add(cls);
    document.querySelectorAll('[data-toggle="' + cls + '"]').forEach(function (cb) { cb.checked = true; });
  });
  if (typeof state.y === 'number') window.scrollTo({ top: state.y, behavior: 'instant' });
  let scrollTimer = null;
  window.addEventListener('scroll', function () {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function () { state.y = window.scrollY; save(); }, 120);
  }, { passive: true });
  document.addEventListener('toggle', function (e) {
    const el = e.target;
    if (!el || !el.id || !el.classList || !el.classList.contains('card')) return;
    state.sections = Object.assign({}, state.sections, { [el.id]: el.open });
    save();
  }, true);
  // Context scrubber: the range input re-sets the readout and the marker (text and SVG attributes only).
  document.querySelectorAll('.scrubber').forEach(function (root) {
    let series = [];
    try { series = JSON.parse(root.getAttribute('data-series') || '[]'); } catch (e) { return; }
    const input = root.querySelector('input.scrub');
    const value = root.querySelector('[data-scrub-value]');
    const meta = root.querySelector('[data-scrub-meta]');
    const line = root.querySelector('[data-scrub-line]');
    const dot = root.querySelector('[data-scrub-dot]');
    if (!input || !series.length) return;
    input.addEventListener('input', function () {
      const p = series[Number(input.value)];
      if (!p) return;
      value.textContent = p[2];
      meta.textContent = p[3];
      line.setAttribute('x1', p[0]); line.setAttribute('x2', p[0]);
      dot.setAttribute('cx', p[0]); dot.setAttribute('cy', p[1]);
    });
  });
  // Mark the nav link of the section in view.
  const links = Array.prototype.slice.call(document.querySelectorAll('.nav a[href^="#"]'));
  if (links.length && 'IntersectionObserver' in window) {
    const byId = {};
    links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
    const seen = new Map();
    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { seen.set(e.target.id, e.isIntersecting ? e.boundingClientRect.top : null); });
      let best = null, bestTop = Infinity;
      seen.forEach(function (top, id) { if (top !== null && top < bestTop) { best = id; bestTop = top; } });
      links.forEach(function (a) { a.removeAttribute('aria-current'); });
      if (best && byId[best]) byId[best].setAttribute('aria-current', 'true');
    }, { rootMargin: '-48px 0px -55% 0px' });
    Object.keys(byId).forEach(function (id) { const el = document.getElementById(id); if (el) io.observe(el); });
  }
  // Conversation replay: reveal .step elements one at a time.
  let step = -1, timer = null;
  const steps = () => Array.prototype.slice.call(document.querySelectorAll('.step'));
  function show(n) {
    const all = steps();
    step = Math.max(-1, Math.min(n, all.length - 1));
    all.forEach(function (el, i) { el.classList.toggle('shown', i <= step); el.classList.toggle('current', i === step); });
    const cur = all[step];
    const pos = document.getElementById('replay-pos');
    if (pos) pos.textContent = (step + 1) + ' / ' + all.length + (cur && cur.getAttribute('data-ts') ? ' · ' + cur.getAttribute('data-ts') : '');
    if (cur) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  function onReplay(a) {
    if (a === 'toggle') { stop(); const on = document.body.classList.toggle('replaying'); show(on ? 0 : steps().length - 1); return; }
    if (a !== 'play') stop();
    if (a === 'start') show(0);
    else if (a === 'prev') show(step - 1);
    else if (a === 'next') show(step + 1);
    else if (a === 'end') show(steps().length - 1);
    else if (a === 'play') {
      if (timer) { stop(); return; }
      timer = setInterval(function () { if (step >= steps().length - 1) stop(); else show(step + 1); }, 1200);
    }
  }
})();
`;
