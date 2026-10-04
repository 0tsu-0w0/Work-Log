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
