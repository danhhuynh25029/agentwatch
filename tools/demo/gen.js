// Writes fictional Claude Code transcripts for README screenshots and the tour GIF.
// Nothing here comes from real sessions. Usage: node tools/demo/gen.js <outDir>
'use strict';
const fs = require('fs');
const path = require('path');

const out = path.resolve(process.argv[2] || 'demo-projects');
fs.rmSync(out, { recursive: true, force: true });

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const hex = (n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
const DAY = 86400000;
const now = Date.now();

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';

/** Builds one transcript: tracks time, context size and ids so usage stays consistent. */
class Session {
  constructor({ project, branch, start, model = OPUS, baseline = 24000, agentId, id }) {
    this.cwd = `/Users/demo/code/${project}`;
    this.branch = branch;
    this.t = start;
    this.model = model;
    this.ctx = 0;
    this.baseline = baseline;
    this.agentId = agentId;
    this.id = id || uuid();
    this.lines = [];
    this.subagents = [];
  }
  ts() {
    return new Date(this.t).toISOString();
  }
  tick(seconds) {
    this.t += seconds * 1000;
  }
  base() {
    return { sessionId: this.id, cwd: this.cwd, gitBranch: this.branch, version: '2.1.320', timestamp: this.ts(), ...(this.agentId ? { agentId: this.agentId, isSidechain: true } : {}) };
  }
  push(o) {
    this.lines.push(JSON.stringify({ ...this.base(), ...o }));
  }
  prompt(text) {
    this.tick(40);
    this.push({ type: 'user', uuid: uuid(), message: { role: 'user', content: text } });
  }
  /** One API message; `grow` is how many tokens the context grows by (tool results, new text). */
  reply({ text, tools = [], grow = 1500, output = 400, stop }) {
    this.tick(6 + rand() * 20);
    const write = this.ctx === 0 ? this.baseline : grow;
    const read = this.ctx;
    this.ctx += write;
    const content = [];
    if (text) content.push({ type: 'text', text });
    const ids = tools.map((t) => {
      const id = 'toolu_' + hex(20);
      content.push({ type: 'tool_use', id, name: t.name, input: t.input });
      return id;
    });
    this.push({
      type: 'assistant',
      uuid: uuid(),
      message: {
        id: 'msg_' + hex(20),
        role: 'assistant',
        model: this.model,
        content,
        stop_reason: stop || (tools.length ? 'tool_use' : 'end_turn'),
        usage: { input_tokens: 3 + Math.floor(rand() * 6), output_tokens: output, cache_creation_input_tokens: write, cache_read_input_tokens: read, cache_creation: { ephemeral_1h_input_tokens: write } },
      },
    });
    tools.forEach((t, i) => {
      this.tick(1 + rand() * 4);
      this.push({
        type: 'user',
        uuid: uuid(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: ids[i], content: t.result ?? 'ok', ...(t.error ? { is_error: true } : {}) }] },
        ...(t.toolUseResult ? { toolUseResult: t.toolUseResult } : {}),
      });
    });
    return ids;
  }
  /** Spawns a subagent with its own transcript; returns nothing, adds the files. */
  agent({ type, description, model, steps, tokens }) {
    const agentId = 'a' + hex(10);
    const sub = new Session({ project: path.basename(this.cwd), branch: this.branch, start: this.t + 2000, model, baseline: 9000, agentId, id: this.id });
    sub.prompt(description);
    for (const s of steps) sub.reply(s);
    const durationMs = sub.t - this.t;
    const [toolId] = this.reply({
      text: `I'll use the ${type} agent for this.`,
      tools: [
        {
          name: 'Agent',
          input: { description, subagent_type: type, prompt: description, model: model.includes('haiku') ? 'haiku' : undefined },
          result: `${type} finished. Summary returned to the main thread.`,
          toolUseResult: { agentId, agentType: type, status: 'completed', totalTokens: tokens, totalDurationMs: durationMs, totalToolUseCount: steps.reduce((n, s) => n + (s.tools?.length || 0), 0) },
        },
      ],
      grow: 2200,
      output: 300,
    });
    this.t = Math.max(this.t, sub.t + 1000);
    this.subagents.push({ agentId, sub, meta: { agentType: type, description, toolUseId: toolId } });
  }
  title(text) {
    this.lines.push(JSON.stringify({ type: 'ai-title', aiTitle: text, sessionId: this.id }));
  }
  cost(usd) {
    this.lines.push(JSON.stringify({ type: 'cost-state', totalCostUSD: usd, sessionId: this.id, timestamp: this.ts() }));
  }
  write() {
    const dir = path.join(out, this.cwd.replace(/[/.]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${this.id}.jsonl`);
    fs.writeFileSync(file, this.lines.join('\n') + '\n');
    for (const { agentId, sub, meta } of this.subagents) {
      const sdir = path.join(dir, this.id, 'subagents');
      fs.mkdirSync(sdir, { recursive: true });
      fs.writeFileSync(path.join(sdir, `agent-${agentId}.jsonl`), sub.lines.join('\n') + '\n');
      fs.writeFileSync(path.join(sdir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
    }
    const mtime = new Date(this.t);
    fs.utimesSync(file, mtime, mtime);
    return file;
  }
}

const read = (file, tokens) => ({ name: 'Read', input: { file_path: file }, result: 'x'.repeat(tokens * 4) });
const edit = (file) => ({ name: 'Edit', input: { file_path: file, old_string: 'total', new_string: 'totalMinor' }, result: 'The file has been updated.' });
const bash = (command, result, error) => ({ name: 'Bash', input: { command, description: command.split(' ')[0] }, result, error });
const commit = (branch, msg) => bash(`git add -A && git commit -m "${msg}"`, `[${branch} ${hex(7)}] ${msg}\n 2 files changed, 48 insertions(+), 12 deletions(-)`);

// Featured session: the one the screenshots open.
function invoices() {
  const b = 'feat/multi-currency-invoices';
  const s = new Session({ project: 'acme-api', branch: b, start: now - 2 * 3600000, baseline: 34000 });
  const src = '/Users/demo/code/acme-api/src/billing/';
  s.prompt('Add multi-currency support to invoices. Totals should be stored in minor units and converted with the daily FX rate.');
  s.reply({ text: 'Let me look at how invoice totals are computed.', tools: [read(src + 'invoice.ts', 1600)], grow: 1700 });
  s.agent({
    type: 'Explore',
    description: 'Map invoice total calculations',
    model: HAIKU,
    tokens: 155000,
    steps: [
      { tools: [{ name: 'Grep', input: { pattern: 'amountCents', path: 'src' }, result: 'src/billing/invoice.ts\nsrc/billing/tax.ts' }], grow: 900 },
      { tools: [read(src + 'tax.ts', 1100), read(src + 'currency.ts', 900)], grow: 2100 },
      { text: 'Totals are computed in invoice.ts and rounded in tax.ts.', grow: 600 },
    ],
  });
  s.reply({ text: 'The FX rates come from the pricing service. Let me check its API.', tools: [{ name: 'mcp__pricing__get_fx_rates', input: { base: 'USD', date: '2026-10-28' }, result: '{"EUR":0.92,"JPY":151.2}' }], grow: 900 });
  s.reply({ text: 'I mapped the billing module. Next I will add a Currency type and migrate totals to minor units.', grow: 800, output: 900 });
  s.prompt('Looks good, go ahead and implement it with tests.');
  s.reply({ tools: [{ name: 'Write', input: { file_path: src + 'money.ts', content: 'export type Money = …' }, result: 'File created.' }], grow: 1800, output: 2600 });
  s.reply({ tools: [edit(src + 'invoice.ts')], grow: 1400, output: 1800 });
  s.reply({ tools: [edit(src + 'tax.ts')], grow: 1200, output: 1200 });
  s.reply({ tools: [read(src + 'tax.ts', 1100)], grow: 1300 });
  s.reply({ tools: [bash('npm test -- billing', 'FAIL src/billing/tax.test.ts › rounds JPY to zero decimals', true)], grow: 1900 });
  s.reply({ text: 'JPY has no minor unit. Fixing the rounding.', tools: [edit(src + 'tax.ts')], grow: 900, output: 800 });
  s.reply({ tools: [bash('npm test -- billing', 'Tests: 42 passed, 42 total')], grow: 1100 });
  s.reply({ tools: [commit(b, 'feat(billing): store invoice totals in minor units with currency')], grow: 500 });
  s.reply({ tools: [{ name: 'mcp__pricing__get_fx_rates', input: { base: 'JPY' }, result: 'Error: upstream timeout after 10s', error: true }], grow: 400 });
  s.agent({
    type: 'code-reviewer',
    description: 'Review the billing diff',
    model: OPUS,
    tokens: 87200,
    steps: [
      { tools: [bash('git diff main...HEAD', 'diff --git a/src/billing/invoice.ts …')], grow: 3200 },
      { text: 'One issue: a missing FX rate falls back to 1.0 silently.', grow: 500, output: 700 },
    ],
  });
  s.reply({ tools: [edit(src + 'invoice.ts')], grow: 900, output: 700 });
  s.reply({ tools: [commit(b, 'fix(billing): fail fast when an FX rate is missing')], grow: 500 });
  s.reply({ text: 'Done. Invoices now store totals in minor units with an explicit currency.', grow: 400, output: 500 });
  s.prompt('Also show the currency in the invoice CSV export.');
  s.reply({ tools: [edit('/Users/demo/code/acme-api/src/export/csv.ts')], grow: 700, output: 400 });
  s.reply({ text: 'The CSV export now has a currency column.', grow: 300, output: 200 });
  s.title('Add multi-currency support to invoices');
  s.cost(0.94);
  return s.write();
}

/** A simpler session: a few prompts, edits and a commit. */
function simple({ project, branch, daysAgo, title, model = OPUS, baseline = 24000, turns = 6, error, agentType }) {
  const s = new Session({ project, branch, start: now - daysAgo * DAY - 3 * 3600000, model, baseline });
  const file = `/Users/demo/code/${project}/src/${title.split(' ')[1]?.toLowerCase() || 'main'}.ts`;
  s.prompt(title + '.');
  s.reply({ text: 'Let me read the relevant code first.', tools: [read(file, 1200 + Math.floor(rand() * 2000))], grow: 1500 });
  if (agentType) s.agent({ type: agentType, description: `Investigate: ${title.toLowerCase()}`, model: HAIKU, tokens: 60000, steps: [{ tools: [read(file, 800)], grow: 1500 }, { text: 'Found it.', grow: 400 }] });
  for (let i = 0; i < turns; i++) s.reply({ tools: [edit(file)], grow: 900 + Math.floor(rand() * 1800), output: 300 + Math.floor(rand() * 1500) });
  if (error) s.reply({ tools: [bash('npm test', error, true)], grow: 1200 });
  s.prompt('Run the tests and commit.');
  s.reply({ tools: [bash('npm test', 'Tests: 18 passed, 18 total')], grow: 900 });
  s.reply({ tools: [commit(branch, title.toLowerCase())], grow: 400 });
  s.reply({ text: 'Committed.', grow: 300, output: 200 });
  s.title(title);
  return s.write();
}

invoices();
simple({ project: 'acme-api', branch: 'perf/orders-query', daysAgo: 2, title: 'Speed up the orders list query', turns: 9, agentType: 'Explore' });
simple({ project: 'web-app', branch: 'fix/checkout-e2e', daysAgo: 1, title: 'Fix flaky checkout e2e test', turns: 7, error: 'Timeout of 5000ms exceeded' });
simple({ project: 'web-app', branch: 'feat/dark-mode', daysAgo: 4, title: 'Implement dark mode toggle', turns: 14, baseline: 52000 });
simple({ project: 'acme-api', branch: 'feat/idempotency-keys', daysAgo: 6, title: 'Add idempotency keys to the payments API', turns: 13 });
simple({ project: 'infra', branch: 'main', daysAgo: 7, title: 'Terraform: add staging read replica', model: SONNET, turns: 6 });
simple({ project: 'web-app', branch: 'chore/forms-validation', daysAgo: 10, title: 'Migrate forms to the new validation library', turns: 16 });
simple({ project: 'acme-api', branch: 'chore/node-24', daysAgo: 13, title: 'Upgrade to Node 24 and fix type errors', turns: 20, error: "TS2345: Argument of type 'string' is not assignable" });
simple({ project: 'infra', branch: 'main', daysAgo: 18, title: 'Rotate CI deploy keys', model: SONNET, turns: 4 });
console.log('wrote demo transcripts to', out);
