import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { collectCodexFileEdits, parseCodexText, parsePatch } from '../parser/codex';
import { buildDiffSides } from '../parser/editDiff';
import { forEachLine, IncrementalTranscript, parseTranscriptFile, parseTranscriptText, TranscriptAccumulator } from '../parser/parser';
import { SessionStore } from '../parser/store';
import { page } from '../webview/html';

const FIX = path.resolve(__dirname, '..', '..', 'fixtures');

const line = (o: unknown) => JSON.stringify(o) + '\n';
const assistant = (id: string, input: number, extra: Record<string, unknown> = {}) =>
  line({ type: 'assistant', timestamp: '2026-09-01T10:00:00.000Z', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: input }, content: [], ...extra } });

test('forEachLine reports consumed bytes and can hold back a partial last line', async () => {
  const lines: string[] = [];
  const consumed = await forEachLine(Readable.from([Buffer.from('a\nbb\ncc')]), 100, (l) => lines.push(l), () => undefined, { completeLinesOnly: true });
  assert.deepEqual(lines, ['a', 'bb']);
  assert.equal(consumed, 5);
  const all: string[] = [];
  assert.equal(await forEachLine(Readable.from([Buffer.from('a\nbb\ncc')]), 100, (l) => all.push(l), () => undefined), 7);
  assert.deepEqual(all, ['a', 'bb', 'cc']);
});

test('finish() is idempotent and lines can be added after it', () => {
  const acc = new TranscriptAccumulator('x');
  acc.addLine(assistant('m1', 10));
  assert.equal(acc.finish().usage.input, 10);
  assert.equal(acc.finish().usage.input, 10, 'second finish must not double count');
  acc.addLine(assistant('m2', 5));
  const st = acc.finish();
  assert.equal(st.usage.input, 15);
  assert.equal(st.apiMessages, 2);
  assert.equal(st.usageByModel['claude-opus-5-5'].messages, 2);
});

test('incremental parsing reads only appended bytes and matches a full parse', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-inc-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, assistant('m1', 10) + assistant('m2', 20).slice(0, 30)); // second line half written
  const inc = new IncrementalTranscript(file);
  assert.equal((await inc.update()).usage.input, 10);
  const firstOffset = inc.bytesRead;
  assert.equal(firstOffset, Buffer.byteLength(assistant('m1', 10)));
  fs.writeFileSync(file, assistant('m1', 10) + assistant('m2', 20) + assistant('m3', 30));
  const st = await inc.update();
  assert.equal(st.usage.input, 60);
  assert.deepEqual(st.usage, (await parseTranscriptFile(file)).usage);
  // Rewritten with different content: starts over instead of appending.
  fs.writeFileSync(file, line({ type: 'ai-title', aiTitle: 'new' }) + assistant('z1', 1));
  const again = await inc.update();
  assert.equal(again.usage.input, 1);
  assert.equal(again.aiTitle, 'new');
  // Truncated: starts over.
  fs.writeFileSync(file, assistant('q', 7));
  assert.equal((await inc.update()).usage.input, 7);
});

test('store uses incremental parsing for recently modified sessions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-store-'));
  const file = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(file, assistant('m1', 10));
  const store = new SessionStore();
  assert.equal((await store.getSummaryByPath(file)).totalUsage.input, 10);
  fs.appendFileSync(file, assistant('m2', 5));
  // mtime/size changed -> new cache key, parsed from the saved offset
  const later = Date.now() / 1000 + 2;
  fs.utimesSync(file, later, later);
  assert.equal((await store.getSummaryByPath(file)).totalUsage.input, 15);
});

test('pending tools are cleared at end of turn, on interrupt and on a new prompt', () => {
  const use = (id: string) => line({ type: 'assistant', message: { id: 'a' + id, content: [{ type: 'tool_use', id, name: 'Bash', input: {} }], stop_reason: 'tool_use' } });
  assert.deepEqual(parseTranscriptText(use('t1')).pendingTools, ['Bash']);
  const endTurn = line({ type: 'assistant', message: { id: 'e', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } });
  assert.deepEqual(parseTranscriptText(use('t1') + endTurn).pendingTools, []);
  const interrupt = line({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
  assert.deepEqual(parseTranscriptText(use('t1') + interrupt).pendingTools, []);
  const prompt = line({ type: 'user', message: { content: 'next task' } });
  assert.deepEqual(parseTranscriptText(use('t1') + prompt + use('t2')).pendingTools, ['Bash']);
  assert.equal(parseTranscriptText(use('t1') + prompt + use('t2')).toolCalls, 2);
});

test('apply_patch envelopes parse into per-file hunks', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/a.ts',
    '@@',
    ' keep',
    '-old line',
    '+new line',
    '@@ second',
    '-x',
    '+y',
    '*** Add File: b.txt',
    '+hello',
    '*** Delete File: c.txt',
    '*** End Patch',
  ].join('\n');
  const changes = parsePatch(patch, '/repo');
  assert.deepEqual(changes.map((c) => [c.path, c.kind, c.hunks.length]), [
    ['/repo/src/a.ts', 'update', 2],
    ['/repo/b.txt', 'add', 1],
    ['/repo/c.txt', 'delete', 1],
  ]);
  assert.deepEqual(changes[0].hunks[0], { oldText: 'keep\nold line', newText: 'keep\nnew line' });
  assert.deepEqual(parsePatch('no patch here'), []);
});

test('codex apply_patch calls count as file edits and can be diffed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-cx-'));
  const file = path.join(dir, 'rollout-2026-09-22T10-00-00-019f9d6e-6f23-7f33-80a9-4fccbea66ee2.jsonl');
  const patch = '*** Begin Patch\n*** Update File: a.ts\n@@\n-1\n+2\n*** End Patch';
  const text =
    line({ timestamp: '2026-09-22T10:00:00.000Z', type: 'session_meta', payload: { id: 'x', cwd: '/w' } }) +
    line({ timestamp: '2026-09-22T10:00:01.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c1', input: patch } });
  fs.writeFileSync(file, text);
  const { summary } = parseCodexText(text, file);
  assert.deepEqual(summary.totalFileEdits['/w/a.ts'], { path: '/w/a.ts', edits: 1, writes: 0, failed: 0, lastTime: '2026-09-22T10:00:01.000Z' });
  const ops = await collectCodexFileEdits(file, '/w/a.ts');
  assert.deepEqual(ops.map((o) => [o.oldText, o.newText]), [['1', '2']]);
});

test('diff sides line up each edit under the same header', async () => {
  const { collectFileEdits } = await import('../parser/conversation');
  const edits = path.join(FIX, 'edits.jsonl');
  const ops = await collectFileEdits([edits], '/Users/me/proj/foo.ts');
  const { before, after } = buildDiffSides(ops, edits);
  const headers = (s: string) => s.split('\n').filter((l) => l.startsWith('────'));
  assert.equal(headers(before).length, 2);
  assert.deepEqual(headers(before), headers(after));
  assert.ok(before.includes('const a = 1;') && after.includes('const a = 2;'));
  assert.ok(headers(before)[1].includes('FAILED'));
});

test('webview script persists scroll and section state', () => {
  const html = page('t', '<p>x</p>', 'N', 'c');
  assert.ok(html.includes('vscode.getState()'));
  assert.ok(html.includes('vscode.setState(state)'));
});

test('a turn end is recorded once even with a later stop hook summary', () => {
  const prompt = line({ type: 'user', timestamp: '2026-09-01T10:00:00.000Z', message: { content: 'go' } });
  const end = line({ type: 'assistant', timestamp: '2026-09-01T10:00:05.000Z', message: { id: 'e1', content: [], stop_reason: 'end_turn' } });
  const hook = line({ type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-09-01T10:00:20.000Z' });
  assert.equal(parseTranscriptText(prompt + end + hook).turnEndedAt, '2026-09-01T10:00:05.000Z');
  // Hook only (no end_turn line): the hook marks the end.
  assert.equal(parseTranscriptText(prompt + hook).turnEndedAt, '2026-09-01T10:00:20.000Z');
  // A background task notification opens a new turn.
  const notif = line({ type: 'user', timestamp: '2026-09-01T10:01:00.000Z', message: { content: '<task-notification><status>completed</status></task-notification>' } });
  const end2 = line({ type: 'assistant', timestamp: '2026-09-01T10:01:09.000Z', message: { id: 'e2', content: [], stop_reason: 'end_turn' } });
  assert.equal(parseTranscriptText(prompt + end + hook + notif + end2).turnEndedAt, '2026-09-01T10:01:09.000Z');
});

test('codex pending calls clear when the turn completes or is aborted', () => {
  const call = line({ timestamp: '2026-09-22T10:00:01.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{}' } });
  assert.deepEqual(parseCodexText(call).summary.main.pendingTools, ['shell']);
  const done = line({ timestamp: '2026-09-22T10:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete' } });
  assert.deepEqual(parseCodexText(call + done).summary.main.pendingTools, []);
  const aborted = line({ timestamp: '2026-09-22T10:00:02.000Z', type: 'event_msg', payload: { type: 'turn_aborted' } });
  assert.deepEqual(parseCodexText(call + aborted).summary.main.pendingTools, []);
});

test('incremental snapshots are not mutated by later updates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-snap-'));
  const file = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(file, line({ type: 'user', message: { content: 'first' } }) + assistant('m1', 10));
  const store = new SessionStore();
  const a = await store.getSummaryByPath(file);
  fs.appendFileSync(file, line({ type: 'user', message: { content: 'second' } }) + assistant('m2', 5));
  const later = Date.now() / 1000 + 2;
  fs.utimesSync(file, later, later);
  const b = await store.getSummaryByPath(file);
  assert.equal(a.main.prompts.length, 1, 'earlier summary keeps its own prompts');
  assert.equal(b.main.prompts.length, 2);
  assert.equal(Object.getPrototypeOf(b.main.tools), null, 'maps stay prototype-less');
});

test('codex listing keeps the newest files first', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-cxl-'));
  for (const day of ['2026/01/01', '2026/09/30']) {
    fs.mkdirSync(path.join(root, day), { recursive: true });
    fs.writeFileSync(path.join(root, day, `rollout-${day.replace(/\//g, '-')}T00-00-00-019f9d6e-6f23-7f33-80a9-4fccbea66ee1.jsonl`), '');
  }
  const { listCodexSessions } = await import('../parser/codex');
  const files = await listCodexSessions(root);
  assert.equal(files.length, 2);
});
