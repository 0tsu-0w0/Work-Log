import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCopilot, normalizeModel, parseCopilotEvents, parseCopilotFile, parseWorkspaceYaml } from '../src/copilot.js';
import { costOf } from '../src/pricing.js';
import { defaultSourceDirs } from '../src/sources.js';
import { Store } from '../src/store.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'copilot');
const SID = 'c0p1107a-5e55-4a1b-9c2d-3e4f5a6b7c8d';
const EVENTS = path.join(FIX, 'session-state', SID, 'events.jsonl');

test('Copilot CLI の events.jsonl をセッションに変換する', async () => {
  const s = await parseCopilotFile(EVENTS);
  assert.equal(s.tool, 'copilot');
  assert.equal(s.id, SID);
  assert.equal(s.cwd, '/home/dev/shop');
  assert.equal(s.project, 'shop');
  assert.equal(s.gitBranch, 'feat/cart');
  assert.equal(s.repoUrl, 'https://github.com/dev/shop');
  assert.equal(s.title, 'カートの合計バグ修正'); // workspace.yaml の name
  assert.deepEqual(s.prompts, ['カートの合計金額のバグを直して', 'テストも足して']);
  assert.equal(s.assistantMessages, 4);
  assert.deepEqual(s.models, ['claude-sonnet-4-5', 'gpt-5']);
  assert.deepEqual(s.changedFiles, ['src/cart.ts', 'src/cart.test.ts']);
  assert.deepEqual(s.toolCalls, { edit: 1, bash: 2, create: 1 });
  assert.deepEqual(s.commitList.map((c) => [c.hash, c.branch, c.subject]), [['9f8e7d6', 'feat/cart', 'fix cart total']]);
  assert.equal(s.pushes, 1);
  assert.equal(s.start, '2026-10-04T02:00:05.000Z');
  assert.equal(s.end, '2026-10-04T03:00:31.000Z');
  assert.equal(s.segments.length, 2); // 1時間空いた再開は別ブロック
  // shutdown のある起動はモデルごとの合計、shutdown の無い起動は応答ごとの出力トークンだけ
  assert.deepEqual(s.usage, {
    '2026-10-04T02|claude-sonnet-4-5||': [30000 - 20000, 260, 20000, 4000, 0, 0],
    '2026-10-04T03|gpt-5||': [0, 400, 0, 0, 0, 0],
  });
  // Copilot の "claude-sonnet-4.5" は単価表の claude-sonnet-4-5 で API 換算する
  assert.ok(costOf('claude-sonnet-4-5', s.usage['2026-10-04T02|claude-sonnet-4-5||']) > 0);
});

test('0.0.3xx の history-session-state と、壊れた・空のファイル', async () => {
  const files = (await listCopilot(FIX)).map((f) => f.file);
  assert.equal(files.length, 4);
  const legacy = await parseCopilotFile(files.find((f) => f.includes('session_0ld5e551')));
  assert.equal(legacy.id, '0ld5e551-aaaa-4bbb-8ccc-dddddddddddd');
  assert.deepEqual(legacy.prompts, ['READMEを更新して']);
  assert.deepEqual(legacy.changedFiles, ['/home/dev/docs/README.md']);
  assert.equal(legacy.commits, 1);
  assert.deepEqual(legacy.models, ['claude-sonnet-4']);
  assert.equal((await parseCopilotFile(files.find((f) => f.includes('empty-session')))).messageCount, 0);
  await assert.rejects(parseCopilotFile(files.find((f) => f.includes('broken'))));
});

test('部品: モデル名・workspace.yaml・ユーザーの依頼以外', () => {
  assert.equal(normalizeModel('claude-opus-4.5'), 'claude-opus-4-5');
  assert.equal(normalizeModel('gpt-5.1-codex'), 'gpt-5.1-codex');
  assert.deepEqual(parseWorkspaceYaml('id: abc\ncwd: /a b\nname: "x: y"\nsummary: \'it\'\'s\'\n'), { id: 'abc', cwd: '/a b', name: 'x: y', summary: "it's" });
  const text = [
    JSON.stringify({ type: 'user.message', timestamp: '2026-10-04T00:00:00Z', data: { content: '自動で続ける', isAutopilotContinuation: true } }),
    JSON.stringify({ type: 'assistant.message', timestamp: '2026-10-04T00:00:01Z', data: { content: 'サブエージェントの応答', parentToolCallId: 't' } }),
  ].join('\n');
  const s = parseCopilotEvents(text, { file: '/x/session-state/abc/events.jsonl' });
  assert.equal(s.id, 'abc');
  assert.equal(s.messageCount, 0);
});

test('Copilot CLI のログを Store で集める', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-log-copilot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'cache'), { recursive: true });
  const store = new Store({ projectsDir: path.join(root, 'none'), cacheDir: path.join(root, 'cache'), sourceDirs: { copilot: FIX } });
  const r = await store.scan();
  assert.equal(r.total, 4);
  const sessions = store.sessions();
  assert.deepEqual(sessions.map((s) => [s.id, s.tool]), [[SID, 'copilot'], ['0ld5e551-aaaa-4bbb-8ccc-dddddddddddd', 'copilot']]);
  const c = store.costs({ tool: 'copilot' });
  assert.deepEqual(c.unknownModels, ['gpt-5']);
  assert.ok(c.buckets.some((b) => b.family === 'Sonnet' && b.usd > 0));
  // 2回目は変わっていないので読み直さない
  assert.equal((await store.scan()).changed, 0);
});

test('既定の場所は COPILOT_HOME と WORKLOG_COPILOT_DIR で変えられる', () => {
  assert.equal(defaultSourceDirs({}, '/home/me').copilot, '/home/me/.copilot');
  assert.equal(defaultSourceDirs({ COPILOT_HOME: '/c' }, '/home/me').copilot, '/c');
  assert.equal(defaultSourceDirs({ WORKLOG_COPILOT_DIR: '/w', COPILOT_HOME: '/c' }, '/home/me').copilot, '/w');
});

// 実際の Copilot CLI 1.0.91 が書いたログ。GitHub にはログインせず、BYOK(COPILOT_PROVIDER_BASE_URL)で手元の偽の
// OpenAI 互換サーバーにつないだ。一時フォルダのパスは /tmp/work-log-real に置き換え、システムプロンプトは省いた
//   a60bc147: README を作ってコミット → 2分半後に --resume で再開して git log
//   e15094b3: src/ が無くて create・edit が失敗し、コミット(exit 1)と push(exit 128)も失敗
const REAL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'copilot-real');
const REAL_ROOT = '/tmp/work-log-real/crepo';

test('実際の Copilot CLI のログ: 依頼・再開・失敗したコマンド・累計の利用量', async () => {
  const files = await listCopilot(REAL);
  assert.equal(files.length, 2); // .session-operation-locks は数えない

  const ok = await parseCopilotFile(path.join(REAL, 'session-state', 'a60bc147-7ad8-4e95-804b-79d788f61111', 'events.jsonl'));
  assert.equal(ok.cwd, REAL_ROOT);
  assert.equal(ok.gitBranch, 'main');
  assert.equal(ok.title, 'README を作ってコミットして');
  // user.message には毎回 parentAgentTaskId(計測用)が付くが、ユーザーの依頼として数える
  assert.deepEqual(ok.prompts, ['README を作ってコミットして', '履歴を確認して']);
  assert.equal(ok.assistantMessages, 5);
  assert.deepEqual(ok.models, ['gpt-4.1']);
  assert.deepEqual(ok.changedFiles, ['README.md']);
  assert.deepEqual(ok.toolCalls, { create: 1, bash: 2 });
  assert.deepEqual(ok.commitList.map((c) => [c.hash, c.branch, c.subject]), [['c97c6ba', 'main', 'docs: README を追加']]);
  assert.equal(ok.start, '2026-10-04T14:30:37.946Z');
  assert.equal(ok.end, '2026-10-04T14:33:12.290Z');
  // 2回目の shutdown の modelMetrics は1回目を含む累計(input 12033 → 50055)。差を取って二重に数えない
  // 偽サーバーの値: prompt 2011/4011/6011 + 18011/20011、cached 200/400/600 + 1800/2000、completion 31〜33 + 39・40
  assert.deepEqual(ok.usage, { '2026-10-04T14|gpt-4.1||': [50055 - 5000, 175, 5000, 0, 0, 0] });

  const failed = await parseCopilotFile(path.join(REAL, 'session-state', 'e15094b3-1a2a-4780-8503-38c5483724cd', 'events.jsonl'));
  assert.deepEqual(failed.prompts, ['src/app.js を追加してコミットして']);
  assert.deepEqual(failed.changedFiles, []); // create・edit は success: false
  assert.deepEqual(failed.toolCalls, { create: 1, edit: 1, bash: 2 });
  // bash は success: true のまま "<shellId: 0 completed with exit code 1>" と shellExecution.exitCode で失敗を表す
  assert.equal(failed.commitAttempts, 1);
  assert.equal(failed.commits, 0);
  assert.equal(failed.pushes, 0);
  assert.deepEqual(failed.usage, { '2026-10-04T14|gpt-4.1||': [60055 - 6000, 180, 6000, 0, 0, 0] });
});
