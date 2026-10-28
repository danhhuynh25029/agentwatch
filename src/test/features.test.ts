import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { AnnotationStore, parseTags, StateStore } from '../annotations';
import { matchesFilter, sinceMs } from '../filter';
import { buildDashboard, compareSessions } from '../parser/aggregate';
import { collectFileEdits, conversationFromText, readConversation } from '../parser/conversation';
import { sessionToMarkdown } from '../parser/export';
import { downsample, localDay, parseSession, parseTranscriptFile, parseTranscriptText } from '../parser/parser';
import { cacheHitRate, formatUsd, Pricing } from '../parser/pricing';
import { renderCompare, renderConversation, renderDashboard } from '../webview/views';

const FIX = path.resolve(__dirname, '..', '..', 'fixtures');
const EDITS = path.join(FIX, 'edits.jsonl');

test('pricing resolves model ids by longest prefix and handles provider prefixes', () => {
  const p = new Pricing();
  assert.equal(p.priceFor('claude-opus-5-5')?.input, 4);
  assert.equal(p.priceFor('claude-opus-5')?.input, 5);
  assert.equal(p.priceFor('claude-opus-4-20250514')?.input, 15);
  assert.equal(p.priceFor('claude-opus-4-8')?.input, 5);
  assert.equal(p.priceFor('us.anthropic.claude-sonnet-4-6')?.input, 3);
  assert.equal(p.priceFor('claude-sonnet-5-5[1m]')?.output, 10);
  assert.equal(p.priceFor('gpt-4'), undefined);
  // 1M input at $4 + 1M output at $20 + 1M cache write at 1.25x + 1M cache read at $0.2
  const u = { input: 1e6, output: 1e6, cacheWrite: 1e6, cacheRead: 1e6 };
  assert.equal(p.cost('claude-opus-5-5', u), 4 + 20 + 5 + 0.2);
  assert.equal(p.cost('unknown-model', u), 0);
  assert.deepEqual(p.unpriced({ 'mystery-1': u, '<synthetic>': u }), ['mystery-1']);
});

test('pricing overrides are validated and can add models', () => {
  const p = new Pricing({ 'claude-opus-5-5': { input: 1, output: 2 }, 'my-model': { input: 1, output: 1, cacheRead: 0 }, bad: { input: 'x' } });
  assert.equal(p.priceFor('claude-opus-5-5')?.input, 1);
  assert.equal(p.cost('my-model', { input: 0, output: 0, cacheWrite: 0, cacheRead: 1e6 }), 0);
  assert.equal(p.priceFor('bad'), undefined);
  assert.equal(new Pricing('garbage').priceFor('claude-opus-5')?.input, 5);
});

test('cache hit rate and USD formatting', () => {
  assert.equal(cacheHitRate({ input: 10, output: 99, cacheWrite: 40, cacheRead: 50 }), 0.5);
  assert.equal(cacheHitRate({ input: 0, output: 5, cacheWrite: 0, cacheRead: 0 }), undefined);
  assert.equal(formatUsd(0), '$0');
  assert.equal(formatUsd(0.004), '<$0.01');
  assert.equal(formatUsd(12.345), '$12.35');
  assert.equal(formatUsd(1234.5), '$1,235');
});

test('parser records file edits, tool errors, compactions, context and pending tools', async () => {
  const st = await parseTranscriptFile(EDITS);
  assert.deepEqual(st.fileEdits['/Users/me/proj/foo.ts'], {
    path: '/Users/me/proj/foo.ts',
    edits: 2,
    writes: 0,
    failed: 1,
    lastTime: '2026-09-20T10:00:03.000Z',
  });
  assert.equal(st.fileEdits['/Users/me/proj/bar.ts'].writes, 1);
  assert.equal(st.toolErrors.length, 1);
  assert.equal(st.toolErrors[0].tool, 'Edit');
  assert.equal(st.toolErrors[0].error, 'String to replace not found');
  assert.match(st.toolErrors[0].input, /"old_string":"nope"/);
  assert.equal(st.compactions.length, 1, 'boundary + summary line count once');
  assert.equal(st.compactions[0].i, 2);
  assert.deepEqual(st.context.map((p) => p.tokens), [1100, 1110, 505]);
  assert.deepEqual(st.pendingTools, ['Bash']);
  assert.equal(st.firstPrompt, 'Refactor foo.ts');
  const day = localDay(Date.parse('2026-09-20T10:00:01.000Z'));
  assert.equal(st.usageByDay[day]['claude-opus-5-5'].messages, 3);
});

test('downsample keeps the first, last and bucket peaks', () => {
  const pts = Array.from({ length: 1000 }, (_, i) => ({ i, tokens: i === 500 ? 99999 : i }));
  const out = downsample(pts, 100);
  assert.equal(out.length, 100);
  assert.equal(out[0].i, 0);
  assert.equal(out[out.length - 1].i, 999);
  assert.ok(out.some((p) => p.tokens === 99999));
});

test('session totals merge per-day usage, file edits and tool errors', async () => {
  const s = await parseSession(EDITS);
  assert.equal(Object.keys(s.totalFileEdits).length, 2);
  assert.equal(s.totalToolErrors.length, 1);
  assert.ok(Object.keys(s.totalByDay).length >= 1);
  const sub = await parseSession(path.join(FIX, 'project', 'sess-sub.jsonl'));
  assert.ok(Object.values(sub.totalByDay).length >= 1);
});

test('conversation reader pairs tool calls with results and marks compactions', async () => {
  const conv = await readConversation(EDITS);
  const kinds = conv.entries.map((e) => e.kind);
  assert.deepEqual(kinds, ['user', 'assistant', 'tool', 'tool', 'tool', 'compact', 'assistant', 'tool']);
  const bad = conv.entries.find((e) => e.kind === 'tool' && e.id === 't_bad');
  assert.ok(bad && bad.kind === 'tool' && bad.isError && bad.result === 'String to replace not found');
  const run = conv.entries[conv.entries.length - 1];
  assert.ok(run.kind === 'tool' && run.input === 'npm test' && run.result === undefined);
  assert.equal(conv.truncated, false);
});

test('conversation merges text blocks of one message and skips noise', () => {
  const conv = conversationFromText(
    [
      JSON.stringify({ type: 'user', message: { content: '<system-reminder>x</system-reminder>' } }),
      JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'a' }] } }),
      JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'b' }] } }),
      'not json',
    ].join('\n'),
  );
  assert.equal(conv.entries.length, 1);
  assert.ok(conv.entries[0].kind === 'assistant' && conv.entries[0].text === 'a\n\nb');
});

test('collectFileEdits returns edits for one file in order, flagging failures', async () => {
  const ops = await collectFileEdits([EDITS], '/Users/me/proj/foo.ts');
  assert.equal(ops.length, 2);
  assert.equal(ops[0].newText, 'const a = 2;');
  assert.equal(ops[1].isError, true);
  const writes = await collectFileEdits([EDITS], '/Users/me/proj/bar.ts');
  assert.deepEqual(writes.map((o) => [o.tool, o.newText]), [['Write', 'export {};']]);
});

test('markdown export includes cost, files, errors and a safe fence', async () => {
  const s = await parseSession(EDITS);
  const conv = await readConversation(EDITS);
  const md = sessionToMarkdown(s, conv, new Pricing(), { includeTools: true, tags: ['refactor'] });
  assert.match(md, /^# Refactor foo\.ts/);
  assert.match(md, /Estimated cost: \*\*<?\$/);
  assert.match(md, /\| \/Users\/me\/proj\/foo\.ts \| 2 \| 0 \| 1 \|/);
  assert.match(md, /String to replace not found/);
  assert.match(md, /Tags \| refactor/);
  assert.match(md, /Context compacted/);
  const withFence = conversationFromText(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'echo ```' } }] } }));
  const md2 = sessionToMarkdown(s, withFence, new Pricing());
  assert.ok(md2.includes('````\necho ```\n````'));
});

test('dashboard aggregates by day, project and model; respects sinceDay', async () => {
  const a = await parseSession(EDITS);
  const b = await parseSession(path.join(FIX, 'basic.jsonl'));
  const pricing = new Pricing();
  const d = buildDashboard([{ summary: a, project: 'proj' }, { summary: b, project: 'other' }], pricing);
  assert.equal(d.sessions, 2);
  assert.equal(d.projects.length, 2);
  assert.ok(d.cost > 0);
  assert.equal(d.days[d.days.length - 1].day, localDay(Date.now()), 'days are filled up to today');
  assert.equal(d.topSessions[0].filePath, a.filePath, 'most expensive first');
  const late = buildDashboard([{ summary: a, project: 'proj' }], pricing, '2999-01-01');
  assert.equal(late.sessions, 0);
  const { html, sessions } = renderDashboard(d, 'All projects', 'N', 'csp:');
  assert.ok(html.includes('<svg'));
  assert.deepEqual(sessions, d.topSessions.map((t) => t.filePath));
});

test('compare and conversation views escape transcript text', async () => {
  const a = await parseSession(EDITS);
  const b = await parseSession(path.join(FIX, 'basic.jsonl'));
  a.title = '<img src=x onerror=1>';
  const html = renderCompare(a, b, compareSessions(a, b, new Pricing()), 'N', 'csp:');
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!/style="/.test(html));
  const conv = conversationFromText(JSON.stringify({ type: 'user', message: { content: '<script>alert(1)</script>' } }));
  const chtml = renderConversation('t', conv, 'N', 'csp:');
  assert.ok(!chtml.includes('<script>alert(1)'));
  assert.ok(chtml.includes('&lt;script&gt;alert(1)'));
});

test('filter matches time range, text, tags and pinned', () => {
  const info = { filePath: '/x/s1.jsonl', sessionId: 's1', projectDir: '/x', mtimeMs: Date.now(), size: 1 };
  const peek = { title: 'Fix login bug', cwd: '/Users/me/app', gitBranch: 'feat/login', firstPrompt: 'please fix' };
  assert.ok(matchesFilter({ query: 'LOGIN' }, info, peek, undefined, {}));
  assert.ok(matchesFilter({ query: '#urgent' }, info, peek, undefined, { tags: ['urgent'] }));
  assert.ok(!matchesFilter({ query: 'nothing' }, info, peek, undefined, {}));
  assert.ok(!matchesFilter({ pinnedOnly: true }, info, peek, undefined, {}));
  assert.ok(matchesFilter({ sinceDays: 0 }, info, peek, undefined, {}));
  assert.ok(!matchesFilter({ sinceDays: 1 }, { ...info, mtimeMs: sinceMs(5) }, peek, undefined, {}));
});

test('annotations: tags are normalised and empty entries removed', async () => {
  const data = new Map<string, unknown>();
  const state: StateStore = {
    get: <T>(k: string, d: T) => (data.has(k) ? (data.get(k) as T) : d),
    update: async (k, v) => void data.set(k, v),
  };
  const store = new AnnotationStore(state);
  let changes = 0;
  store.onDidChange(() => changes++);
  assert.deepEqual(parseTags('#a, b  a,,c'), ['a', 'b', 'c']);
  assert.equal(await store.togglePin('s1'), true);
  await store.set('s1', { tags: ['x'], note: 'hello' });
  assert.deepEqual(store.get('s1'), { pinned: true, tags: ['x'], note: 'hello' });
  assert.deepEqual([...store.pinnedIds()], ['s1']);
  await store.set('s1', { pinned: false, tags: [], note: '' });
  assert.deepEqual(store.get('s1'), {});
  assert.deepEqual(data.get('agentwatch.annotations'), {});
  assert.deepEqual(store.get('__proto__'), {});
  assert.equal(changes, 3);
});

test('stats from text without timestamps still produce context points', () => {
  const st = parseTranscriptText(JSON.stringify({ type: 'assistant', message: { id: 'm', model: 'claude-haiku-5-5', usage: { input_tokens: 3 } } }));
  assert.equal(st.context.length, 1);
  assert.equal(Object.keys(st.usageByDay).length, 0);
});
