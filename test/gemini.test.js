import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listGemini, parseGeminiFile, parseGeminiText, readConversation, resolveProjectRoot } from '../src/gemini.js';
import { modelFamily, setPricingOverrides } from '../src/pricing.js';
import { defaultSourceDirs } from '../src/sources.js';
import { Store } from '../src/store.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gemini');
const SID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const MAIN = path.join(FIX, 'tmp', 'webapp', 'chats', 'session-2026-10-04T01-00-1a2b3c4d.jsonl');

test('Gemini CLI の JSONL(新形式)をセッションに変換する', async () => {
  const s = await parseGeminiFile(MAIN, { projectId: 'webapp' });
  assert.equal(s.tool, 'gemini');
  assert.equal(s.id, SID);
  assert.equal(s.cwd, '/home/dev/webapp'); // .project_root から
  assert.equal(s.project, 'webapp');
  assert.equal(s.title, 'ログイン画面のバリデーション修正'); // $set の summary
  assert.deepEqual(s.prompts, ['ログイン画面のバリデーションを直して']); // "/stats" は依頼にしない
  assert.equal(s.assistantMessages, 3); // 同じ id の更新は1件
  assert.deepEqual(s.models, ['gemini-2.5-pro']);
  assert.deepEqual(s.changedFiles, ['src/login.ts']);
  assert.deepEqual(s.toolCalls, { replace: 1, run_shell_command: 2 });
  // "Output: [main 4f5e6d7] …" からコミットを読み、Exit Code: 1 の push は数えない
  assert.deepEqual(s.commitList.map((c) => [c.hash, c.branch, c.subject]), [['4f5e6d7', 'main', 'fix login validation']]);
  assert.equal(s.commits, 1);
  assert.equal(s.pushes, 0);
  assert.equal(s.start, '2026-10-04T01:00:05.000Z');
  assert.equal(s.end, '2026-10-04T01:02:00.000Z');
  assert.equal(s.segments.length, 1);
  // 入力はキャッシュ分を除き、思考トークンは出力に含める。更新前の(tokens の無い)行は数えない
  assert.deepEqual(s.usage, { '2026-10-04T01|gemini-2.5-pro||': [4000 + 3000 + 200, 300 + 200 + 120 + 40, 8000 + 12000 + 15000, 0, 0, 0] });
});

test('旧形式(1つの JSON・ハッシュのフォルダ)とプロジェクトの解決', async () => {
  const files = await listGemini(FIX);
  const legacy = files.find((f) => f.file.endsWith('9f8e7d6c.json'));
  const s = await parseGeminiFile(legacy.file, legacy);
  assert.equal(s.cwd, '/home/dev/legacy-api'); // projects.json のパスの sha256 がフォルダ名と一致
  assert.deepEqual(s.changedFiles, ['README.md']);
  assert.deepEqual(s.usage, { '2025-08-01T09|gemini-2.5-flash||': [2000, 600, 0, 0, 0, 0] });
  // どこにも登録の無いハッシュは、ツールの引数の絶対パスを上へたどって探す
  const unknown = files.find((f) => f.file.endsWith('77777777.json'));
  assert.equal((await parseGeminiFile(unknown.file, unknown)).cwd, '/srv/tools');
  assert.equal(resolveProjectRoot({ projectId: 'f'.repeat(64) }), null);
});

test('一覧: サブエージェントと logs.json だけのセッション、壊れたファイル', async () => {
  const files = await listGemini(FIX);
  const sub = files.find((f) => f.parentId);
  assert.equal(sub.parentId, SID);
  // chats にあるセッションは logs.json から重ねて作らない
  const logs = files.filter((f) => f.sessionId);
  assert.deepEqual(logs.map((f) => f.sessionId), ['0ld5e55i-0000-4000-8000-000000000000']);
  const s = await parseGeminiFile(logs[0].file, logs[0]);
  assert.deepEqual(s.prompts, ['テストを追加して']);
  assert.equal(s.cwd, '/home/dev/webapp');
  assert.equal(s.assistantMessages, 0);
  // 書き込み途中で壊れたファイルは中身の無いセッションになる(例外にしない)
  const broken = files.find((f) => f.file.endsWith('deadbeef.json'));
  assert.equal((await parseGeminiFile(broken.file, broken)).messageCount, 0);
  assert.deepEqual(await listGemini(path.join(FIX, 'none')), []);
});

test('$rewindTo で消されたメッセージも作業として残す', () => {
  const text = [
    JSON.stringify({ sessionId: 's', projectHash: 'h', startTime: '2026-10-04T00:00:00Z' }),
    JSON.stringify({ id: 'a', timestamp: '2026-10-04T00:00:01Z', type: 'user', content: 'one' }),
    JSON.stringify({ $rewindTo: 'a' }),
    JSON.stringify({ id: 'b', timestamp: '2026-10-04T00:00:05Z', type: 'user', content: 'two' }),
  ].join('\n');
  assert.deepEqual(readConversation(text).messages.map((m) => m.id), ['a', 'b']);
  assert.deepEqual(parseGeminiText(text).prompts, ['one', 'two']);
});

test('Gemini のモデルは単価が分からなければ「不明」、単価表があれば計算する', async (t) => {
  assert.equal(modelFamily('gemini-2.5-pro'), 'Gemini');
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-log-gemini-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => setPricingOverrides({}));
  await mkdir(path.join(root, 'cache'), { recursive: true });
  const store = new Store({ projectsDir: path.join(root, 'none'), cacheDir: path.join(root, 'cache'), sourceDirs: { gemini: FIX } });
  await store.scan();
  const sessions = store.sessions();
  // サブエージェントは一覧に出さず、壊れたファイル・中身の無いものも出さない
  assert.deepEqual(sessions.map((s) => s.id).sort(), ['0ld5e55i-0000-4000-8000-000000000000', SID, '77777777-0000-4000-8000-000000000000', '9f8e7d6c-1111-4222-8333-444455556666'].sort());
  assert.ok(sessions.every((s) => s.tool === 'gemini'));
  assert.ok(store.costs({ tool: 'gemini' }).unknownModels.includes('gemini-2.5-pro'));

  // 単価表(テスト用の値)を置くと、次のスキャンから計算される
  await writeFile(path.join(root, 'cache', 'pricing.json'), JSON.stringify({ 'gemini-2.5-pro': { input: 1, output: 10, cacheRead: 0.1 }, 'gemini-2.5-flash': { input: 1, output: 1 } }));
  await store.scan();
  const c = store.costs({ tool: 'gemini' });
  assert.deepEqual(c.unknownModels, []);
  // 親セッションのコストにサブエージェント(flash 3050 トークン)を含める
  const main = c.topSessions.find((x) => x.id === SID);
  assert.ok(Math.abs(main.usd - ((7200 * 1 + 660 * 10 + 35000 * 0.1) / 1e6 + 3050 / 1e6)) < 1e-12);
});

test('既定の場所は GEMINI_CLI_HOME と WORKLOG_GEMINI_DIR で変えられる', () => {
  assert.equal(defaultSourceDirs({}, '/home/me').gemini, '/home/me/.gemini');
  assert.equal(defaultSourceDirs({ GEMINI_CLI_HOME: '/x' }, '/home/me').gemini, '/x/.gemini');
  assert.equal(defaultSourceDirs({ WORKLOG_GEMINI_DIR: '/y' }, '/home/me').gemini, '/y');
});
