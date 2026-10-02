import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { parseSession } from '../parser/parser';
import { matchesWorkspace } from '../parser/store';
import { esc, renderSession } from '../webview/render';

const FIX = path.resolve(__dirname, '..', '..', 'fixtures');

test('esc escapes HTML metacharacters', () => {
  assert.equal(esc(`<img src=x onerror="a">'&`), '&lt;img src=x onerror=&quot;a&quot;&gt;&#39;&amp;');
});

test('renderSession escapes untrusted transcript text and uses a nonce CSP', async () => {
  const s = await parseSession(path.join(FIX, 'project', 'sess-sub.jsonl'));
  s.title = '<script>alert(1)</script>';
  s.main.prompts.push({ text: '<b onclick="x()">hi</b>' });
  const { html, transcripts } = renderSession(s, 'NONCE123', 'vscode-resource:');
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<b onclick'));
  assert.ok(html.includes("script-src 'nonce-NONCE123'"));
  assert.ok(!/style="/.test(html), 'inline style attributes would be blocked by CSP');
  assert.equal(transcripts[0], s.filePath);
  assert.equal(transcripts.length, 3); // main + 2 subagents with transcripts
});

test('matchesWorkspace matches cwd, sub-folders and encoded folder names', () => {
  assert.ok(matchesWorkspace('-x', '/Users/me/proj', ['/Users/me/proj']));
  assert.ok(matchesWorkspace('-x', '/Users/me/proj/sub', ['/Users/me/proj/']));
  assert.ok(!matchesWorkspace('-x', '/Users/me/project2', ['/Users/me/proj']));
  assert.ok(matchesWorkspace('-Users-me-my-work', undefined, ['/Users/me/my_work']));
  assert.ok(!matchesWorkspace('-Users-me-proj', undefined, []));
});
