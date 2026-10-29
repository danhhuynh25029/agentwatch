import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cleanPromptText,
  DEFAULT_LIMITS,
  isGitCommitCommand,
  parseSession,
  parseTranscriptFile,
  parseTranscriptText,
  stripNoiseTags,
} from '../parser/parser';
import { resolveTranscriptUnderRoot } from '../parser/store';
import { isPosixShell, isSafeSessionId, shellQuote, stripControlChars } from '../shell';
import { SubagentNode } from '../parser/types';
import { flattenAgents } from '../webview/render';

const FIX = path.resolve(__dirname, '..', '..', 'fixtures');

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentwatch-sec-'));
  return fn(tmp).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
}

function assistantLine(id: string, model: string, tools: Array<{ id: string; name: string; input?: object }>): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-15T08:00:00.000Z',
    message: {
      id,
      model,
      usage: { input_tokens: 1, output_tokens: 2 },
      content: tools.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input ?? {} })),
    },
  });
}

test('transcript-controlled keys like "__proto__" do not pollute Object.prototype', async () => {
  const lines = [
    assistantLine('m1', '__proto__', [
      { id: 't1', name: '__proto__' },
      { id: 't2', name: 'constructor' },
      { id: 't3', name: 'mcp____proto____x' },
      { id: 't4', name: 'mcp__srv__constructor' },
      { id: 't5', name: 'Skill', input: { skill: '__proto__' } },
    ]),
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', is_error: true },
          { type: 'tool_result', tool_use_id: 't3', is_error: true },
        ],
      },
    }),
  ];
  const st = parseTranscriptText(lines.join('\n'));
  const probe = {} as Record<string, unknown>;
  assert.equal(probe.calls, undefined);
  assert.equal(probe.input, undefined);
  assert.equal(probe.messages, undefined);
  assert.equal(probe.tools, undefined);
  assert.equal(Object.getPrototypeOf(probe), Object.prototype);
  assert.equal(Object.keys(Object.prototype).length, 0);

  assert.deepEqual({ ...st.tools['__proto__'] }, { name: '__proto__', calls: 1, errors: 1 });
  assert.deepEqual({ ...st.tools['constructor'] }, { name: 'constructor', calls: 1, errors: 0 });
  assert.equal(st.mcp['__proto__'].calls, 1);
  assert.equal(st.mcp['__proto__'].errors, 1);
  assert.equal(st.mcp['__proto__'].tools.x.calls, 1);
  assert.equal(st.mcp.srv.tools['constructor'].calls, 1);
  assert.equal(st.skills['__proto__'], 1);
  assert.equal(st.usageByModel['__proto__'].messages, 1);
  assert.deepEqual(st.models, ['__proto__']);
  assert.deepEqual(Object.keys(st.tools).sort(), ['Skill', '__proto__', 'constructor']);

  // Session-level totals go through mergeTools/mergeMcp and the totals maps.
  await withTmp(async (dir) => {
    const file = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const s = await parseSession(file);
    assert.equal(({} as Record<string, unknown>).calls, undefined);
    assert.equal(({} as Record<string, unknown>).input, undefined);
    assert.equal(s.totalTools['__proto__'].calls, 1);
    assert.equal(s.totalTools['constructor'].calls, 1);
    assert.equal(s.totalMcp['__proto__'].tools.x.calls, 1);
    assert.equal(s.totalSkills['__proto__'], 1);
    assert.equal(s.totalByModel['__proto__'].messages, 1);
    assert.deepEqual(s.models, ['__proto__']);
  });
});

test('noise tag stripping is linear on unclosed tags', () => {
  for (const input of [
    '<system-reminder>'.repeat(60000),
    '<system-reminder '.repeat(60000) + '>',
    '<command-name>'.repeat(60000),
    '<ide_selection>'.repeat(30000) + '</ide_selection>'.slice(1),
  ]) {
    const t0 = performance.now();
    cleanPromptText(input);
    const ms = performance.now() - t0;
    assert.ok(ms < 500, `took ${ms.toFixed(0)} ms for input starting ${input.slice(0, 20)}`);
  }
});

test('stripNoiseTags matches the original regex semantics', () => {
  const OLD =
    /<(ide_selection|ide_opened_file|ide_diagnostics|system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|command-message|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/g;
  const cases = [
    'a<system-reminder>x</system-reminder>b',
    '<system-reminder foo="1">x</system-reminder><ide_selection>y</ide_selection>z',
    '<system-reminderX>x</system-reminderX>',
    '<system-reminder>a<system-reminder>b</system-reminder>c</system-reminder>',
    '<ide_selection>never closed <ide_opened_file>f</ide_opened_file> tail',
    '<system-reminder',
    '<system-reminder>',
    '< system-reminder>x</system-reminder>',
    '<system-reminder-x>x</system-reminder-x>',
    '<command-message>m</command-message>hello<local-command-stdout a>o</local-command-stdout>',
    'plain text < not a tag >',
  ];
  // Plus random combinations of tag fragments.
  const parts = ['<system-reminder>', '</system-reminder>', '<ide_selection x>', '</ide_selection>', '<', '>', 'a', ' ', '<system-reminder', '_'];
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 2000; i++) {
    let s = '';
    const len = Math.floor(rnd() * 12);
    for (let j = 0; j < len; j++) s += parts[Math.floor(rnd() * parts.length)];
    cases.push(s);
  }
  for (const c of cases) assert.equal(stripNoiseTags(c), c.replace(OLD, ' '), JSON.stringify(c));
});

test('oversized lines are dropped while streaming and counted as bad', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'big-line.jsonl');
    const fd = fs.openSync(file, 'w');
    try {
      fs.writeSync(fd, '{"type":"ai-title","aiTitle":"');
      const block = Buffer.alloc(1024 * 1024, 'x');
      for (let i = 0; i < 40; i++) fs.writeSync(fd, block); // one ~40 MB line
      fs.writeSync(fd, '"}\n' + JSON.stringify({ type: 'ai-title', aiTitle: 'ok' }) + '\n');
    } finally {
      fs.closeSync(fd);
    }
    const limits = { maxTranscriptBytes: DEFAULT_LIMITS.maxTranscriptBytes, maxLineBytes: 1024 * 1024 };
    const before = process.memoryUsage().heapUsed;
    const st = await parseTranscriptFile(file, limits);
    assert.equal(st.badLines, 1);
    assert.equal(st.lines, 2);
    assert.equal(st.aiTitle, 'ok');
    // The 40 MB line must never be materialized as a string (generous bound for GC noise).
    assert.ok(process.memoryUsage().heapUsed - before < 30 * 1024 * 1024);
  });
});

test('line splitter decodes UTF-8 split across chunk boundaries and keeps a final unterminated line', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'utf8.jsonl');
    const title = 'Tiếng Việt 日本語 🚀 '.repeat(20);
    const lines = [
      JSON.stringify({ type: 'summary', summary: 'first' }),
      '',
      JSON.stringify({ type: 'ai-title', aiTitle: title }) + '\r',
    ];
    fs.writeFileSync(file, lines.join('\n')); // no trailing newline
    for (const highWaterMark of [1, 2, 3, 5, 7, 64]) {
      const st = await parseTranscriptFile(file, { ...DEFAULT_LIMITS, highWaterMark });
      assert.equal(st.aiTitle, title, `highWaterMark=${highWaterMark}`);
      assert.equal(st.summaryTitle, 'first');
      assert.equal(st.badLines, 0);
      assert.equal(st.lines, 2);
    }
  });
});

test('transcripts over the size limit are skipped and flagged', async () => {
  const limits = { ...DEFAULT_LIMITS, maxTranscriptBytes: 100 };
  const st = await parseTranscriptFile(path.join(FIX, 'basic.jsonl'), limits);
  assert.match(st.skipped ?? '', /too large/);
  assert.equal(st.lines, 0);
  const ok = await parseTranscriptFile(path.join(FIX, 'basic.jsonl'));
  assert.equal(ok.skipped, undefined);
  assert.ok(ok.lines > 0);
});

test('oversized meta.json is ignored and subagent count is capped', async () => {
  await withTmp(async (dir) => {
    fs.cpSync(path.join(FIX, 'project'), dir, { recursive: true });
    const sess = path.join(dir, 'sess-sub.jsonl');
    const meta = path.join(dir, 'sess-sub', 'subagents', 'agent-aaa111.meta.json');
    const orig = JSON.parse(fs.readFileSync(meta, 'utf8'));
    fs.writeFileSync(meta, JSON.stringify({ ...orig, agentType: 'Big', pad: 'x'.repeat(DEFAULT_LIMITS.maxMetaBytes) }));
    const s = await parseSession(sess);
    const a = s.subagents.find((n) => n.agentId === 'aaa111');
    assert.ok(a);
    assert.equal(a.meta, undefined);
    assert.notEqual(a.agentType, 'Big');
    assert.equal(s.subagentFilesSkipped, undefined);

    const capped = await parseSession(sess, { ...DEFAULT_LIMITS, maxSubagentFiles: 1 });
    assert.equal(capped.subagentFilesSkipped, 1);
  });
});

test('deep subagent chains are finalized iteratively with correct depth and totals', async () => {
  const N = 150;
  await withTmp(async (dir) => {
    const sess = path.join(dir, 'chain.jsonl');
    const sub = path.join(dir, 'chain', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(sess, assistantLine('m0', 'm', [{ id: 'spawn0', name: 'Agent' }]) + '\n');
    for (let i = 0; i < N; i++) {
      const spawns = i < N - 1 ? [{ id: `spawn${i + 1}`, name: 'Agent' }] : [];
      fs.writeFileSync(path.join(sub, `agent-a${i}.jsonl`), assistantLine(`m${i + 1}`, 'm', spawns) + '\n');
      fs.writeFileSync(path.join(sub, `agent-a${i}.meta.json`), JSON.stringify({ toolUseId: `spawn${i}` }));
    }
    const s = await parseSession(sess);
    assert.equal(s.agentCount, N);
    assert.equal(s.subagents.length, 1);
    const flat = flattenAgents(s.subagents);
    assert.equal(flat.length, N);
    assert.deepEqual(
      flat.map((n) => n.depth),
      Array.from({ length: N }, (_, i) => i + 1),
    );
    // Each transcript has 1 input + 2 output tokens.
    assert.equal(flat[0].totalUsage.input + flat[0].totalUsage.output, 3 * N);
    assert.equal(flat[N - 1].totalUsage.output, 2);
  });
});

test('flattenAgents handles very deep chains without stack overflow', () => {
  const N = 200_000;
  const mk = (id: number): SubagentNode => ({ agentId: String(id), children: [] }) as unknown as SubagentNode;
  const root = mk(0);
  let cur = root;
  for (let i = 1; i < N; i++) {
    const c = mk(i);
    cur.children.push(c);
    cur = c;
  }
  const flat = flattenAgents([root, mk(-1)]);
  assert.equal(flat.length, N + 1);
  assert.equal(flat[1].agentId, '1');
  assert.equal(flat[N].agentId, '-1');
});

test('resolveTranscriptUnderRoot only accepts .jsonl files inside the root', async () => {
  await withTmp(async (dir) => {
    const root = path.join(dir, 'projects');
    fs.mkdirSync(path.join(root, 'p'), { recursive: true });
    const inside = path.join(root, 'p', 's.jsonl');
    fs.writeFileSync(inside, '');
    fs.writeFileSync(path.join(root, 'p', 'notes.txt'), '');
    const outside = path.join(dir, 'outside.jsonl');
    fs.writeFileSync(outside, '');
    fs.symlinkSync(outside, path.join(root, 'p', 'link.jsonl'));

    assert.equal(await resolveTranscriptUnderRoot(root, inside), inside);
    assert.equal(await resolveTranscriptUnderRoot(root, path.join(root, 'p', '..', 'p', 's.jsonl')), inside);
    assert.equal(await resolveTranscriptUnderRoot(root, outside), undefined);
    assert.equal(await resolveTranscriptUnderRoot(root, path.join(root, '..', 'outside.jsonl')), undefined);
    assert.equal(await resolveTranscriptUnderRoot(root, path.join(root, 'p', 'link.jsonl')), undefined);
    assert.equal(await resolveTranscriptUnderRoot(root, path.join(root, 'p', 'notes.txt')), undefined);
    assert.equal(await resolveTranscriptUnderRoot(root, path.join(root, 'p', 'missing.jsonl')), undefined);
    assert.equal(await resolveTranscriptUnderRoot(root, ''), undefined);
    fs.mkdirSync(path.join(root, 'p', 'dir.jsonl'));
    assert.equal(await resolveTranscriptUnderRoot(root, path.join(root, 'p', 'dir.jsonl')), undefined);
  });
});

test('spawn-only subagent nodes are capped per session', async () => {
  await withTmp(async (dir) => {
    const sess = path.join(dir, 'spawns.jsonl');
    const spawns = Array.from({ length: 30 }, (_, i) => ({ id: `sp${i}`, name: 'Agent' }));
    fs.writeFileSync(sess, assistantLine('m0', 'm', spawns) + '\n');
    const s = await parseSession(sess, { ...DEFAULT_LIMITS, maxSpawnNodes: 10 });
    assert.equal(s.agentCount, 10);
    assert.equal(s.spawnNodesSkipped, 20);
    const all = await parseSession(sess);
    assert.equal(all.agentCount, 30);
    assert.equal(all.spawnNodesSkipped, undefined);
  });
});

test('git commit detection stays linear on crafted commands', () => {
  const start = Date.now();
  assert.equal(isGitCommitCommand(';git -C '.repeat(25_000)), false);
  assert.equal(isGitCommitCommand('|git -c x=y '.repeat(25_000)), false);
  assert.ok(Date.now() - start < 500, `took ${Date.now() - start} ms`);
});

test('terminal helpers reject option-like ids and control characters', () => {
  assert.ok(isSafeSessionId('2f9c1e6a-1b2c-4d5e-8f90-123456789abc'));
  assert.ok(!isSafeSessionId('--dangerously-skip-permissions'));
  assert.ok(!isSafeSessionId('.hidden'));
  assert.ok(!isSafeSessionId('a b'));
  assert.equal(stripControlChars('fix\u001b[2J it\r\nnow\t!'), 'fix[2J it\nnow\t!');
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.ok(isPosixShell('/bin/zsh') && isPosixShell('/usr/bin/bash'));
  assert.ok(!isPosixShell('/opt/homebrew/bin/fish') && !isPosixShell(undefined));
});
