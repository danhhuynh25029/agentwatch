import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { buildDashboard } from '../parser/aggregate';
import { Conversation } from '../parser/conversation';
import { detectLoop, promptCosts, sessionInsights } from '../parser/insights';
import { CACHE_TTL_1H_MS, CACHE_TTL_5M_MS, parseSession, parseTranscriptText, TranscriptAccumulator } from '../parser/parser';
import { Pricing } from '../parser/pricing';
import { searchConversation, snippetAround } from '../parser/search';
import { SessionSummary, ToolErrorEntry } from '../parser/types';
import { renderSession } from '../webview/render';
import { renderDashboard } from '../webview/views';

const FIX = path.resolve(__dirname, '..', '..', 'fixtures');
const line = (o: unknown) => JSON.stringify(o);
const prompt = (text: string, ts: string) => line({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const reply = (id: string, ts: string, usage: Record<string, unknown>) =>
  line({ type: 'assistant', timestamp: ts, message: { id, model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: 'ok' }] } });

const transcript = [
  prompt('first question', '2026-09-01T10:00:00.000Z'),
  reply('m1', '2026-09-01T10:00:05.000Z', { input_tokens: 10, cache_creation_input_tokens: 20000, cache_read_input_tokens: 0, output_tokens: 100 }),
  prompt('big refactor', '2026-09-01T10:01:00.000Z'),
  reply('m2', '2026-09-01T10:01:05.000Z', { input_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20000, output_tokens: 5000 }),
  reply('m3', '2026-09-01T10:02:05.000Z', { input_tokens: 5, cache_creation_input_tokens: 500, cache_read_input_tokens: 21000, output_tokens: 8000 }),
  prompt('small fix', '2026-09-01T10:03:00.000Z'),
  reply('m4', '2026-09-01T10:03:05.000Z', { input_tokens: 5, cache_read_input_tokens: 21500, output_tokens: 50 }),
].join('\n');

test('usage is attributed to the prompt it answers', () => {
  const s = parseTranscriptText(transcript);
  assert.deepEqual(
    s.prompts.map((p) => p.messages),
    [1, 2, 1],
  );
  assert.equal(s.prompts[1].usage?.['claude-opus-5-5'].output, 13000);
  // Repeated finish() does not double count.
  const acc = new TranscriptAccumulator('x');
  for (const l of transcript.split('\n')) acc.addLine(l);
  acc.finish();
  assert.equal(acc.finish().prompts[1].usage?.['claude-opus-5-5'].output, 13000);
});

test('baseline context and cache expiry come from the API messages', () => {
  const s = parseTranscriptText(transcript);
  assert.equal(s.baselineTokens, 20010);
  assert.equal(s.cacheTouchedAt, '2026-09-01T10:03:05.000Z');
  assert.equal(s.cacheTtlMs, CACHE_TTL_5M_MS);
  const oneHour = parseTranscriptText(
    reply('h1', '2026-09-01T10:00:05.000Z', { input_tokens: 1, cache_creation_input_tokens: 900, cache_creation: { ephemeral_1h_input_tokens: 900 } }),
  );
  assert.equal(oneHour.cacheTtlMs, CACHE_TTL_1H_MS);
  assert.equal(parseTranscriptText(reply('n', '2026-09-01T10:00:05.000Z', { input_tokens: 3 })).cacheTouchedAt, undefined);
});

test('the dominant prompt is reported and costs add up', async () => {
  const s = await parseSession(path.join(FIX, 'edits.jsonl'));
  const summary: SessionSummary = { ...s, main: parseTranscriptText(transcript) };
  const pricing = new Pricing();
  const costs = promptCosts(summary, pricing);
  assert.equal(costs.length, 3);
  assert.ok(costs[1] > costs[0] && costs[1] > costs[2]);
  const hint = sessionInsights(summary, pricing).find((i) => i.title.startsWith('One prompt drove'));
  assert.ok(hint, 'dominant prompt insight');
  assert.match(hint!.detail, /big refactor/);
});

const err = (tool: string, error: string, timestamp: string): ToolErrorEntry => ({ tool, error, input: '', timestamp });

test('detectLoop finds a trailing run of identical errors only', () => {
  const t = (m: number) => `2026-09-01T10:0${m}:00.000Z`;
  const run = [err('Bash', 'npm ERR! missing script', t(0)), err('Bash', 'npm ERR!  missing script', t(1)), err('Bash', 'npm ERR! missing script', t(2))];
  assert.equal(detectLoop(run)?.count, 3);
  assert.equal(detectLoop([...run, err('Read', 'no such file', t(3))]), undefined);
  assert.equal(detectLoop(run.slice(0, 2)), undefined);
  const slow = [err('Bash', 'x', '2026-09-01T10:00:00.000Z'), err('Bash', 'x', '2026-09-01T10:20:00.000Z'), err('Bash', 'x', '2026-09-01T10:40:00.000Z')];
  assert.equal(detectLoop(slow), undefined, 'spread over 40 minutes is not a loop');
});

test('searchConversation matches prompts, replies and tool fields case-insensitively', () => {
  const conv: Conversation = {
    truncated: false,
    entries: [
      { kind: 'user', text: 'Why does the build fail with ECONNREFUSED?' },
      { kind: 'assistant', text: 'Checking the server.' },
      { kind: 'tool', name: 'Bash', input: '{"command":"curl localhost:3000"}', result: 'curl: (7) Failed: econnrefused' },
    ],
  };
  const hits = searchConversation(conv, 'econnrefused');
  assert.deepEqual(
    hits.map((h) => h.where),
    ['You', 'Bash result'],
  );
  assert.deepEqual(searchConversation(conv, '   '), []);
  assert.equal(searchConversation(conv, 'e', 1).length, 1);
  assert.equal(snippetAround('a'.repeat(200) + 'NEEDLE' + 'b'.repeat(200), 200, 6).length, 6 + 120 + 2);
});

test('dashboard groups by branch and averages the starting context per project', async () => {
  const pricing = new Pricing();
  const a = await parseSession(path.join(FIX, 'edits.jsonl'));
  const b = await parseSession(path.join(FIX, 'extra.jsonl'));
  const d = buildDashboard(
    [
      { summary: a, project: 'p' },
      { summary: b, project: 'p' },
    ],
    pricing,
  );
  assert.ok(d.branches.length >= 1);
  assert.equal(
    d.branches.reduce((x, r) => x + r.sessions, 0),
    d.sessions,
  );
  const html = renderDashboard(d, 'All', 'N', 'c').html;
  assert.match(html, /id="branches"/);
  assert.match(html, /Start ctx/);
});

test('session panel shows cost by prompt and the starting context', async () => {
  const s = await parseSession(path.join(FIX, 'edits.jsonl'));
  const summary: SessionSummary = { ...s, main: parseTranscriptText(transcript) };
  const html = renderSession(summary, 'N', 'c', { pricing: new Pricing() }).html;
  assert.match(html, /By prompt/);
  assert.match(html, /big refactor/);
  assert.match(html, /at the first API message/);
});

test('secondary table columns are marked for hiding in narrow panels, never the first', async () => {
  const { table } = await import('../webview/html');
  const html = table(['Model', 'API msgs', 'Total', 'Duration', 'Cost'], ['<tr><td>a</td><td>1</td><td>2</td><td>3</td><td>4</td></tr>']);
  assert.match(html, /<table class="hm-2 hn-4">/);
  assert.doesNotMatch(table(['Tokens', 'Cost'], ['<tr><td>1</td><td>2</td></tr>']), /hn-/);
});
