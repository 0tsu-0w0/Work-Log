import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSessionFile, buildSegments, projectNameFrom } from '../src/parser.js';
import { classifyWorkType, inferComponents, heuristicSummary } from '../src/tagger.js';
import { mask } from '../src/mask.js';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE = path.join(FIXTURE_DIR, '11111111-2222-3333-4444-555555555555.jsonl');

test('セッションログを集計する', async () => {
  const s = await parseSessionFile(FIXTURE, FIXTURE_DIR);
  assert.equal(s.id, '11111111-2222-3333-4444-555555555555');
  assert.equal(s.project, 'myapp');
  assert.equal(s.gitBranch, 'feature/login');
  assert.equal(s.title, 'ログイン画面のバグ修正');
  assert.equal(s.start, '2026-09-28T01:00:00.000Z');
  assert.equal(s.end, '2026-09-28T03:31:00.000Z');
  // メタ行とtool_resultはプロンプトに数えない
  assert.equal(s.userMessages, 2);
  // 同じ message.id の分割行は1件
  assert.equal(s.assistantMessages, 4);
  assert.equal(s.messageCount, 6);
  assert.equal(s.commits, 1);
  assert.deepEqual(s.changedFiles, ['src/auth/login.ts', 'src/auth/login.test.ts', 'README.md']);
  assert.deepEqual(s.toolCalls, { Edit: 2, Write: 1, Bash: 1 });
  assert.equal(s.tokens.input, 110); // msg_1 の usage は重複加算しない
  assert.equal(s.tokens.cacheRead, 1000);
  assert.deepEqual(s.models, ['claude-sonnet-5-5']);
});

test('30分以上の空白でアクティビティ区間を分ける', async () => {
  const s = await parseSessionFile(FIXTURE, FIXTURE_DIR);
  assert.equal(s.segments.length, 2);
  assert.deepEqual(s.segments[1], { start: '2026-09-28T03:30:00.000Z', end: '2026-09-28T03:31:00.000Z' });
  assert.equal(s.activeMs, 10.5 * 60000 + 60000);
  assert.equal(buildSegments([]).length, 0);
});

test('プロジェクト名の推定', () => {
  assert.equal(projectNameFrom('/home/a/b/my-app', null), 'my-app');
  assert.equal(projectNameFrom(null, '/x/-home-a-work'), 'work');
});

test('作業種別とコンポーネントの推定', async () => {
  const s = await parseSessionFile(FIXTURE, FIXTURE_DIR);
  assert.equal(classifyWorkType(s), 'バグ修正');
  assert.equal(classifyWorkType({ title: '設定画面を追加', prompts: ['設定画面を実装して'] }), '機能');
  assert.equal(classifyWorkType({ title: '', prompts: ['このエラーはなぜ?'], changedFiles: [] }), '調査');
  assert.deepEqual(inferComponents(['src/auth/a.ts', 'src/auth/b.ts', 'README.md', '/etc/hosts']), ['src/auth', 'README.md']);
  const h = heuristicSummary(s);
  assert.equal(h.source, 'heuristic');
  assert.match(h.summary, /3ファイルを変更、1回コミット/);
});

test('秘匿情報をマスキングする', () => {
  assert.equal(mask('key sk-ant-api03-abcdefghijklmnop'), 'key [ANTHROPIC_KEY]');
  assert.equal(mask('token=abcd1234secret'), 'token=[REDACTED]');
  assert.equal(mask('ghp_abcdefghijklmnopqrstuvwxyz0123'), '[GITHUB_TOKEN]');
  assert.equal(mask('https://user:pass@example.com/x'), 'https://[CREDENTIALS]@example.com/x');
  assert.equal(mask('mail me@example.com'), 'mail [EMAIL]');
  assert.equal(mask('普通の文章'), '普通の文章');
});
