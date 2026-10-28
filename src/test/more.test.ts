import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeBlocks, mergeHours } from '../parser/blocks';
import { codexSessionId, isCodexTranscript, listCodexSessions, parseCodexFile } from '../parser/codex';
import { sessionInsights } from '../parser/insights';
import { normalizeServerName, readConfiguredServers, unusedServers } from '../parser/mcpConfig';
import { isGitCommitCommand, parseCommitOutput, parseSession, parseTranscriptFile } from '../parser/parser';
import { Pricing } from '../parser/pricing';
import { csvCell, rowsToCsv, sessionRows } from '../parser/report';
import { SessionStore } from '../parser/store';
import { renderSession } from '../webview/render';
import { renderConversation } from '../webview/views';

const FIX = path.resolve(__dirname, '..', '..', 'fixtures');
const EXTRA = path.join(FIX, 'extra.jsonl');
const CODEX = path.join(FIX, 'codex', 'rollout-2026-09-22T10-00-00-019f9d6e-6f23-7f33-80a9-4fccbea66ee1.jsonl');

test('git commit output is parsed', () => {
  assert.deepEqual(parseCommitOutput('[feature/x 1a2b3c4] fix: thing\n 2 files changed'), { branch: 'feature/x', hash: '1a2b3c4', message: 'fix: thing' });
  assert.deepEqual(parseCommitOutput('[main (root-commit) abcdef0] init'), { branch: 'main', hash: 'abcdef0', message: 'init' });
  assert.equal(parseCommitOutput('nothing to commit'), undefined);
});

test('parser records commits with usage snapshot, result sizes, reads, turn end and reported cost', async () => {
  const st = await parseTranscriptFile(EXTRA);
  assert.equal(st.commits.length, 1);
  assert.equal(st.commits[0].hash, '1a2b3c4d');
  assert.equal(st.commits[0].message, 'feat: x');
  assert.equal(st.commits[0].failed, undefined);
  // Snapshot is taken when the commit is requested: m1 and m2 are known by then.
  assert.equal(st.commits[0].usageAtCommit['claude-opus-5-5'].input, 2_000_000);
  assert.deepEqual(st.resultSizes.Read, { name: 'Read', calls: 2, chars: 30 });
  assert.deepEqual(st.fileReads['/Users/me/proj/a.ts'], { path: '/Users/me/proj/a.ts', reads: 2, chars: 30 });
  assert.equal(st.largestResults[0].tool, 'Bash');
  assert.ok(st.largestResults.every((r, i, a) => i === 0 || a[i - 1].chars >= r.chars));
  assert.equal(st.lastStopReason, 'end_turn');
  assert.equal(st.turnEndedAt, '2026-09-21T14:30:00.000Z');
  assert.equal(st.reportedCostUsd, 8.5);
  assert.deepEqual(Object.keys(st.usageByHour).sort(), ['2026-09-21T09', '2026-09-21T14']);
});

test('5-hour blocks split on the first activity after the window ends', async () => {
  const s = await parseSession(EXTRA);
  const blocks = computeBlocks(s.totalByHour, new Pricing(), Date.parse('2026-09-21T15:00:00Z'));
  assert.equal(blocks.length, 2);
  assert.equal(new Date(blocks[0].start).toISOString(), '2026-09-21T09:00:00.000Z');
  assert.equal(new Date(blocks[1].start).toISOString(), '2026-09-21T14:00:00.000Z');
  assert.equal(blocks[0].cost, 8);
  assert.ok(blocks[1].active && !blocks[0].active);
  assert.ok((blocks[1].burnRateUsd ?? 0) > 0);
  const merged = mergeHours([s.totalByHour, s.totalByHour]);
  assert.equal(merged['2026-09-21T09']['claude-opus-5-5'].input, 4_000_000);
});

test('insights flag low cache hit and repeated errors', async () => {
  const s = await parseSession(EXTRA);
  const titles = sessionInsights(s, new Pricing()).map((i) => i.title);
  assert.ok(titles.some((t) => t.startsWith('Low cache hit rate')));
  s.totalToolErrors = Array.from({ length: 3 }, () => ({ tool: 'Bash', input: '', error: 'permission denied' }));
  assert.ok(sessionInsights(s, new Pricing()).some((i) => i.title === 'Same tool error 3×'));
});

test('session panel renders commits, context use and insights without inline styles', async () => {
  const s = await parseSession(EXTRA);
  s.main.commits[0].message = '<img src=x onerror=1>';
  const { html } = renderSession(s, 'N', 'c', { pricing: new Pricing() });
  assert.ok(html.includes('1a2b3c4d'));
  assert.ok(html.includes('What fills the context'));
  assert.ok(html.includes('Claude Code recorded'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!/style="/.test(html));
});

test('CSV cells are quoted and protected against formula injection', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('-12.5'), '-12.5');
  assert.equal(csvCell('+cmd'), "'+cmd");
  assert.equal(csvCell(undefined), '');
});

test('session rows and CSV export', async () => {
  const s = await parseSession(EXTRA);
  const rows = sessionRows([{ summary: s, project: 'proj' }], new Pricing());
  assert.equal(rows[0].commits, 1);
  assert.equal(rows[0].reportedCostUsd, 8.5);
  const csv = rowsToCsv(rows);
  assert.ok(csv.startsWith('start,end,project,title'));
  assert.equal(csv.trim().split('\r\n').length, 2);
});

test('configured MCP servers: only names are read, unused ones found', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-mcp-'));
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(
    path.join(dir, 'claude.json'),
    JSON.stringify({ mcpServers: { github: { env: { TOKEN: 'secret' } } }, projects: { [proj]: { mcpServers: { 'my.db': {} } } } }),
  );
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { docs: {} } }));
  const servers = await readConfiguredServers(path.join(dir, 'claude.json'), [proj]);
  assert.deepEqual(servers.map((x) => `${x.scope}:${x.name}`).sort(), ['local:my.db', 'project:docs', 'user:github']);
  assert.ok(!JSON.stringify(servers).includes('secret'));
  assert.equal(normalizeServerName('my.db'), 'my_db');
  assert.deepEqual(unusedServers(servers, ['my_db', 'docs']).map((x) => x.name), ['github']);
  assert.deepEqual(await readConfiguredServers(path.join(dir, 'missing.json'), []), []);
});

test('codex rollouts map to sessions with usage, tools, errors and conversation', async () => {
  assert.ok(isCodexTranscript(CODEX));
  assert.ok(!isCodexTranscript(EXTRA));
  assert.equal(codexSessionId(CODEX), '019f9d6e-6f23-7f33-80a9-4fccbea66ee1');
  const { summary, conversation } = await parseCodexFile(CODEX);
  assert.equal(summary.title, 'List the files');
  assert.equal(summary.main.cwd, '/Users/me/codexproj');
  assert.deepEqual(summary.models, ['gpt-5-codex']);
  // input excludes cached tokens: 2500 - 1400
  assert.deepEqual(summary.totalUsage, { input: 1100, output: 80, cacheWrite: 0, cacheRead: 1400 });
  assert.equal(summary.main.apiMessages, 2);
  assert.deepEqual(summary.totalTools.shell, { name: 'shell', calls: 1, errors: 1 });
  assert.equal(summary.totalToolErrors[0].error, 'ls: denied');
  assert.equal(summary.main.lastStopReason, 'end_turn');
  assert.deepEqual(summary.main.context.map((p) => p.tokens), [1000, 1500]);
  assert.deepEqual(conversation.entries.map((e) => e.kind), ['user', 'tool', 'assistant']);
  const tool = conversation.entries[1];
  assert.ok(tool.kind === 'tool' && tool.input === 'ls -la' && tool.isError);
  const store = new SessionStore();
  const st = fs.statSync(CODEX);
  const viaStore = await store.getSummary({ filePath: CODEX, sessionId: 'x', projectDir: '', mtimeMs: st.mtimeMs, size: st.size });
  assert.equal(viaStore.title, 'List the files');
  const peek = await store.peek({ filePath: CODEX, sessionId: 'x', projectDir: '', mtimeMs: st.mtimeMs, size: st.size });
  assert.equal(peek.cwd, '/Users/me/codexproj');
  const listed = await listCodexSessions(FIX);
  assert.deepEqual(listed.map((f) => path.basename(f.filePath)), [path.basename(CODEX)]);
});

test('conversation view wraps entries as replay steps', async () => {
  const { conversation } = await parseCodexFile(CODEX);
  const html = renderConversation('t', conversation, 'N', 'c');
  assert.equal((html.match(/class="step"/g) ?? []).length, 3);
  assert.ok(html.includes('data-replay="play"'));
});

test('1-hour cache writes are priced at 2x input, 5-minute at 1.25x', () => {
  const p = new Pricing();
  const base = { input: 0, output: 0, cacheRead: 0 };
  assert.equal(p.cost('claude-opus-5-5', { ...base, cacheWrite: 1e6 }), 5);
  assert.equal(p.cost('claude-opus-5-5', { ...base, cacheWrite: 1e6, cacheWrite1h: 1e6 }), 8);
  assert.equal(p.cost('claude-opus-5-5', { ...base, cacheWrite: 1e6, cacheWrite1h: 5e5 }), 6.5);
});

test('git commit detection ignores heredoc bodies and quoted mentions', () => {
  assert.ok(isGitCommitCommand('git add -A && git commit -q -m "x"'));
  assert.ok(isGitCommitCommand('cd repo; git -C sub commit -m x'));
  assert.ok(isGitCommitCommand('git commit -F - <<EOF\nmsg\nEOF'));
  assert.ok(!isGitCommitCommand("python3 - <<'EOF'\nprint('git commit')\nEOF"));
  assert.ok(!isGitCommitCommand('echo "remember to git commit"'));
  assert.ok(!isGitCommitCommand('git status'));
});
