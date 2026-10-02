import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanPromptText, parseSession, parseTranscriptFile, splitMcpName } from '../parser/parser';
import { formatTokens, totalTokens } from '../parser/format';
import { encodeProjectPath, listProjects, LruCache, SessionStore } from '../parser/store';

// Compiled to out/test/, fixtures live at <repo>/fixtures.
const FIX = path.resolve(__dirname, '..', '..', 'fixtures');

test('usage is deduped by message.id across split lines', async () => {
  const st = await parseTranscriptFile(path.join(FIX, 'basic.jsonl'));
  assert.deepEqual(st.usage, { input: 11, output: 22, cacheWrite: 103, cacheRead: 1004 });
  assert.equal(st.apiMessages, 2);
  assert.equal(st.usageByModel['claude-opus-5'].messages, 1);
  assert.equal(st.usageByModel['claude-opus-5'].cacheRead, 1000);
  assert.deepEqual(st.models, ['claude-opus-5', 'claude-haiku-5']);
});

test('malformed and truncated lines are skipped, unknown types ignored', async () => {
  const st = await parseTranscriptFile(path.join(FIX, 'basic.jsonl'));
  assert.equal(st.badLines, 2);
  assert.equal(st.aiTitle, 'Final title');
  assert.equal(st.cwd, '/Users/me/proj');
  assert.equal(st.gitBranch, 'main');
  assert.equal(st.version, '2.1.0');
  assert.equal(st.startTime, '2026-09-15T08:00:00.000Z');
  assert.equal(st.endTime, '2026-09-15T08:01:01.000Z');
  assert.deepEqual(
    st.prompts.map((p) => p.text),
    ['Fix the bug in foo', '/review MR 12'],
  );
  assert.deepEqual(st.tools.Read, { name: 'Read', calls: 1, errors: 1 });
});

test('MCP names split on the last "__" and are counted per server/tool', async () => {
  assert.deepEqual(splitMcpName('mcp__claude_ai_Claude_Docs__batch'), { server: 'claude_ai_Claude_Docs', tool: 'batch' });
  assert.deepEqual(splitMcpName('mcp__confluence__get_page_by_url'), { server: 'confluence', tool: 'get_page_by_url' });
  assert.equal(splitMcpName('Read'), undefined);

  const st = await parseTranscriptFile(path.join(FIX, 'mcp.jsonl'));
  const docs = st.mcp['claude_ai_Claude_Docs'];
  assert.equal(docs.calls, 3);
  assert.equal(docs.tools.batch.calls, 2);
  assert.equal(docs.tools.guide.calls, 1);
  assert.equal(st.mcp.confluence.errors, 1);
  assert.equal(st.mcp.confluence.tools.get_page_by_url.errors, 1);
  assert.equal(st.tools.Bash.calls, 1);
  assert.equal(st.tools['mcp__confluence__get_page_by_url'], undefined);
  assert.equal(st.skills['code-review'], 1);
  assert.equal(st.toolCalls, 6);
});

test('subagents are linked via meta.json toolUseId, recursively', async () => {
  const s = await parseSession(path.join(FIX, 'project', 'sess-sub.jsonl'));
  assert.equal(s.title, 'Explore the repo');
  assert.equal(s.agentCount, 3);
  assert.equal(s.subagents.length, 2);

  const explore = s.subagents.find((a) => a.agentId === 'aaa111')!;
  assert.ok(explore);
  assert.equal(explore.agentType, 'Explore');
  assert.equal(explore.description, 'Explore config');
  assert.equal(explore.model, 'claude-sonnet-5');
  assert.equal(explore.status, 'completed');
  assert.equal(explore.spawn?.toolUseId, 'toolu_spawn1');
  assert.equal(explore.depth, 1);
  // msg_s1 repeated on two lines -> counted once.
  assert.deepEqual(explore.stats.usage, { input: 10, output: 10, cacheWrite: 0, cacheRead: 1000 });
  assert.equal(explore.durationMs, 58000);

  assert.equal(explore.children.length, 1);
  const nested = explore.children[0];
  assert.equal(nested.agentId, 'bbb222');
  assert.equal(nested.description, 'Nested dig');
  assert.equal(nested.depth, 2);
  assert.equal(totalTokens(explore.totalUsage), 1020 + 10);

  // Old-style Task spawn without a transcript is kept but contributes no tokens.
  const old = s.subagents.find((a) => a.spawn?.toolUseId === 'toolu_spawn_old')!;
  assert.ok(old);
  assert.equal(old.transcriptPath, '');
  assert.equal(old.reportedTokens, 4242);
  assert.equal(old.agentType, 'general-purpose');

  // Totals: main 150 + explore 1020 + nested 10.
  assert.equal(totalTokens(s.main.usage), 150);
  assert.equal(totalTokens(s.totalUsage), 1180);
  assert.equal(s.totalMcp.confluence.tools.get_page_by_id.calls, 1);
  assert.equal(s.totalTools.Read.calls, 1);
  assert.equal(s.totalTools.Agent.calls, 2);
  assert.deepEqual(Object.keys(s.totalByModel).sort(), ['claude-haiku-5', 'claude-opus-5', 'claude-sonnet-5']);
});

test('cleanPromptText filters noise', () => {
  assert.equal(cleanPromptText('<task-notification>x</task-notification>'), undefined);
  assert.equal(cleanPromptText('<system-reminder>a</system-reminder>  '), undefined);
  assert.equal(cleanPromptText('<ide_opened_file>f</ide_opened_file>hello'), 'hello');
  assert.equal(cleanPromptText('<command-name>/clear</command-name>'), '/clear');
});

test('format helpers', () => {
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1234), '1.2K');
  assert.equal(formatTokens(1_234_567), '1.2M');
  assert.equal(encodeProjectPath('/Users/a/my_work/x.y'), '-Users-a-my-work-x-y');
});

test('LruCache evicts oldest entry', () => {
  const c = new LruCache<string, number>(2);
  c.set('a', 1);
  c.set('b', 2);
  c.get('a');
  c.set('c', 3);
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 1);
  assert.equal(c.size, 2);
});

test('SessionStore lists projects and de-duplicates concurrent parses', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentwatch-'));
  try {
    const proj = path.join(tmp, '-Users-me-proj');
    fs.mkdirSync(proj);
    fs.copyFileSync(path.join(FIX, 'basic.jsonl'), path.join(proj, 'sess-basic.jsonl'));
    const projects = await listProjects(tmp);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].decodedPath, '/Users/me/proj');
    const info = projects[0].sessions[0];
    const store = new SessionStore();
    const [a, b] = await Promise.all([store.getSummary(info), store.getSummary(info)]);
    assert.equal(a, b);
    assert.equal(a.title, 'Final title');
    const peek = await store.peek(info);
    assert.equal(peek.cwd, '/Users/me/proj');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('missing file rejects instead of hanging', async () => {
  await assert.rejects(parseTranscriptFile(path.join(FIX, 'does-not-exist.jsonl')));
});
