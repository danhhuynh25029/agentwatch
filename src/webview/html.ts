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
  eyebrow?: string;
  title: string;
  /** Trusted HTML: chips row. */
  meta?: string;
  /** Trusted HTML: action buttons. */
  actions?: string;
  /** Trusted HTML under the title. */
  extra?: string;
}

export function hero(o: HeroOptions): string {
  return `<header class="hero">${o.eyebrow ? `<div class="eyebrow">${esc(o.eyebrow)}</div>` : ''}<h1>${esc(o.title)}</h1>${
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
let chartSeq = 0;

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
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const maxY = Math.max(1, ...points.map((p) => p.y)) * 1.08;
  const spanX = maxX - minX || 1;
  const sx = (x: number) => PAD + ((x - minX) / spanX) * (CHART_W - 2 * PAD);
  const sy = (y: number) => CHART_H - PAD - (y / maxY) * (CHART_H - 2 * PAD);
  const id = `g${++chartSeq}`;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const area = `${line} L${sx(points[points.length - 1].x).toFixed(1)},${CHART_H - PAD} L${sx(points[0].x).toFixed(1)},${CHART_H - PAD} Z`;
  const marks = markers
    .map((m) => `<line class="chart-marker" x1="${sx(m.x).toFixed(1)}" x2="${sx(m.x).toFixed(1)}" y1="0" y2="${CHART_H}"><title>${esc(m.title ?? '')}</title></line>`)
    .join('');
  const dots = points
    .map((p) => `<circle class="chart-dot" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="4"><title>${esc(p.title ?? '')}</title></circle>`)
    .join('');
  return `<div class="chart">${yAxis(maxY, yLabel)}<svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" role="img"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="stop-a"/><stop offset="1" class="stop-b"/></linearGradient></defs>${gridLines()}<path class="chart-area" fill="url(#${id})" d="${area}"/>${marks}<path class="chart-line" d="${line}"/>${dots}</svg></div>`;
}

/** Vertical bar chart as inline SVG, one bar per value. */
export function barChart(values: ChartPoint[], yLabel: (v: number) => string, tone: Tone = 'blue'): string {
  if (values.length === 0) return '<div class="empty">No data</div>';
  const maxY = Math.max(1e-9, ...values.map((v) => v.y)) * 1.08;
  const w = (CHART_W - 2 * PAD) / values.length;
  const id = `g${++chartSeq}`;
  const bars = values
    .map((v, i) => {
      const h = (v.y / maxY) * (CHART_H - 2 * PAD);
      const x = PAD + i * w;
      return `<rect class="chart-bar" fill="url(#${id})" rx="3" x="${(x + w * 0.15).toFixed(1)}" y="${(CHART_H - PAD - h).toFixed(1)}" width="${(w * 0.7).toFixed(1)}" height="${Math.max(h, 0).toFixed(1)}"><title>${esc(v.title ?? '')}</title></rect>`;
    })
    .join('');
  return `<div class="chart tone-${tone}">${yAxis(maxY, yLabel)}<svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" role="img"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="bar-a"/><stop offset="1" class="bar-b"/></linearGradient></defs>${gridLines()}${bars}</svg></div>`;
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
  --accent: var(--vscode-charts-blue, #3794ff);
  --line: color-mix(in srgb, var(--fg) 10%, transparent);
  --line-strong: color-mix(in srgb, var(--fg) 18%, transparent);
  --surface: color-mix(in srgb, var(--fg) 2.5%, var(--bg));
  --hover: color-mix(in srgb, var(--fg) 4%, transparent);
  --ink: color-mix(in srgb, var(--fg) 70%, transparent);
  --red: var(--vscode-errorForeground, #f85149);
  --green: var(--vscode-charts-green, #89d185);
  --radius: 8px;
  --mono: var(--vscode-editor-font-family, ui-monospace, monospace);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg); background: var(--bg); line-height: 1.55; -webkit-font-smoothing: antialiased; }
.wrap { max-width: 1120px; margin: 0 auto; padding: 28px 32px 72px; }
a { color: var(--fg); text-decoration: none; }
code, .mono { font-family: var(--mono); font-size: 0.92em; }
code { background: var(--hover); padding: 1px 5px; border-radius: 4px; }
h1, h2, h3 { margin: 0; }
h3 { font-size: 11px; margin: 24px 0 10px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; }
.muted { color: var(--muted); }
.err { color: var(--red); }
.good { color: var(--green); }
.small { font-size: 12px; }

/* Header */
.hero { padding: 4px 0 22px; margin-bottom: 4px; }
.eyebrow { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin-bottom: 8px; }
.hero h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.015em; line-height: 1.3; word-break: break-word; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 5px; border: 1px solid var(--line); color: var(--muted); font-size: 12px; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.chip-icon { opacity: 0.7; }
.note { margin-top: 14px; padding: 2px 0 2px 12px; border-left: 2px solid var(--line-strong); color: var(--muted); white-space: pre-wrap; }
.toolbar { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 18px; }

/* Buttons */
.btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; border: 1px solid transparent; border-radius: 6px; padding: 0 12px; cursor: pointer; font: inherit; font-size: 12.5px; transition: background 0.12s, border-color 0.12s, color 0.12s; }
.btn-primary { background: var(--fg); color: var(--bg); font-weight: 500; }
.btn-primary:hover { background: color-mix(in srgb, var(--fg) 85%, var(--bg)); }
.btn-secondary { background: transparent; color: var(--fg); border-color: var(--line-strong); }
.btn-secondary:hover { background: var(--hover); }
.btn-ghost { background: transparent; color: var(--muted); }
.btn-ghost:hover { color: var(--fg); background: var(--hover); }
.btn-link { height: auto; background: none; border: none; padding: 0; color: var(--fg); text-align: left; word-break: break-word; text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 3px; }
.btn-link:hover { text-decoration-color: var(--fg); }
.btn-icon { opacity: 0.8; }

/* Navigation */
.nav { position: sticky; top: 0; z-index: 5; display: flex; gap: 2px; flex-wrap: wrap; margin: 0 0 8px; border-bottom: 1px solid var(--line); background: var(--bg); }
.nav a { padding: 10px 12px 9px; color: var(--muted); font-size: 12.5px; border-bottom: 1px solid transparent; margin-bottom: -1px; }
.nav a:hover { color: var(--fg); border-bottom-color: var(--fg); }

/* Stats */
.caption { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; margin: 22px 0 10px; font-weight: 600; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.kpi { padding: 16px 18px; background: var(--bg); min-width: 0; }
.kpi-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
.kpi-value { font-size: 24px; font-weight: 500; margin-top: 6px; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; line-height: 1.2; }
.kpi-sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
.kpi-sub .err { color: var(--red); }

/* Sections */
.card { border-top: 1px solid var(--line); margin: 0; padding: 4px 0 8px; scroll-margin-top: 48px; }
.wrap > .card:first-of-type, .nav + .card { border-top: none; }
.sec-head { display: flex; align-items: baseline; gap: 10px; padding: 22px 0 4px; list-style: none; }
details.card > summary { cursor: pointer; user-select: none; }
details.card > summary::-webkit-details-marker { display: none; }
details.card:not([open]) > summary { padding-bottom: 18px; }
.chev { margin-left: auto; transition: transform 0.15s; color: var(--muted); font-size: 16px; line-height: 1; }
details.card[open] .chev { transform: rotate(90deg); }
.sec-title { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; display: inline-flex; align-items: baseline; gap: 8px; }
.sec-icon { display: none; }
.sec-sub { color: var(--muted); font-size: 12px; }
.count { font-size: 12px; font-weight: 400; color: var(--muted); font-variant-numeric: tabular-nums; }
.sec-body { padding: 10px 0 14px; }
.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 0 32px; }
.empty { color: var(--muted); padding: 18px; text-align: center; border: 1px dashed var(--line); border-radius: var(--radius); }

/* Tables */
.tbl { overflow: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 8px 10px; vertical-align: top; }
th:first-child, td:first-child { padding-left: 0; }
th:last-child, td:last-child { padding-right: 0; }
thead th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; white-space: nowrap; border-bottom: 1px solid var(--line-strong); }
tbody td { border-bottom: 1px solid var(--line); }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover td { background: var(--hover); }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ts { white-space: nowrap; color: var(--muted); font-size: 12px; }
table.kv { width: auto; }
table.kv th { color: var(--muted); font-weight: 400; padding-right: 32px; text-transform: none; letter-spacing: 0; font-size: 13px; border: none; }
table.kv td { border: none; }
.cell-strong { font-weight: 500; }

/* Pills */
.pill { display: inline-flex; align-items: center; padding: 0 7px; height: 20px; border-radius: 4px; font-size: 11.5px; border: 1px solid var(--line-strong); color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.pill-err { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); }
.pill-ok { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
.pill-warn { color: var(--vscode-editorWarning-foreground, #cca700); border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 40%, transparent); }
.pill-live { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
.pill-live::before { content: ''; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: currentColor; margin-right: 6px; animation: blink 2s ease-in-out infinite; }
@keyframes blink { 50% { opacity: 0.3; } }

/* Share bars */
meter.share { width: 100%; min-width: 80px; height: 4px; vertical-align: middle; }
meter.share::-webkit-meter-bar { background: var(--line); border: none; border-radius: 2px; height: 4px; }
meter.share::-webkit-meter-optimum-value, meter.share::-webkit-meter-suboptimum-value, meter.share::-webkit-meter-even-less-good-value { background: var(--ink); border-radius: 2px; }
meter.block-meter { margin-top: 14px; }
meter.share.tone-red::-webkit-meter-optimum-value { background: var(--red); }

/* Timeline */
ol.timeline { list-style: none; padding: 0 0 0 16px; margin: 0; position: relative; }
ol.timeline::before { content: ''; position: absolute; left: 3px; top: 8px; bottom: 8px; width: 1px; background: var(--line-strong); }
ol.timeline li { position: relative; padding: 2px 0 14px 8px; }
ol.timeline li::before { content: ''; position: absolute; left: -16px; top: 8px; width: 7px; height: 7px; border-radius: 50%; background: var(--bg); border: 1px solid var(--muted); }
ol.timeline .ts { display: block; font-size: 11.5px; }
.pt { white-space: pre-wrap; word-break: break-word; }

pre { white-space: pre-wrap; word-break: break-word; background: var(--surface); border: 1px solid var(--line); padding: 8px 10px; border-radius: 6px; margin: 4px 0; font-family: var(--mono); font-size: 12px; max-height: 340px; overflow: auto; }

/* Charts */
.chart { position: relative; margin: 8px 0 4px; padding-left: 52px; }
.chart svg { width: 100%; height: 180px; display: block; overflow: visible; }
.y-axis { position: absolute; left: 0; top: 0; bottom: 0; width: 46px; display: flex; flex-direction: column; justify-content: space-between; font-size: 11px; color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
.grid { stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
.stop-a { stop-color: var(--accent); stop-opacity: 0.16; }
.stop-b { stop-color: var(--accent); stop-opacity: 0; }
.bar-a, .bar-b { stop-color: var(--fg); stop-opacity: 0.32; }
.chart-area { stroke: none; }
.chart-line { fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.chart-dot { fill: var(--bg); stroke: var(--accent); stroke-width: 1.5; opacity: 0; vector-effect: non-scaling-stroke; }
.chart-dot:hover { opacity: 1; }
.chart-bar:hover { opacity: 1.8; filter: brightness(1.6); }
.chart-marker { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
.legend { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.legend b { color: var(--fg); font-weight: 500; }
.legend .swatch-marker { color: var(--muted); }
.axis-note { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; padding-left: 52px; margin-top: 4px; }

/* Gantt */
.gantt svg { display: block; }
.gantt-label { fill: var(--fg); font-size: 11.5px; font-family: var(--vscode-font-family); white-space: pre; }
.gantt-track { fill: var(--hover); }
.gantt-bar { fill: var(--ink); }
.gantt-bar.error { fill: var(--red); }

/* Insights */
.insights { display: flex; flex-direction: column; gap: 0; border-top: 1px solid var(--line); }
.insight { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.insight .ic { flex: none; width: 6px; height: 6px; border-radius: 50%; margin-top: 7px; background: var(--muted); }
.insight.warn .ic { background: var(--vscode-editorWarning-foreground, #cca700); }
.insight .t { font-weight: 500; }
.insight .d { color: var(--muted); font-size: 12px; word-break: break-word; }

/* Loading */
.loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; height: 80vh; }
.spinner { width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid var(--line-strong); border-top-color: var(--fg); animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 640px) { .wrap { padding: 16px; } .grid-2 { grid-template-columns: 1fr; } .chart { padding-left: 0; } .y-axis { display: none; } .axis-note { padding-left: 0; } }
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
