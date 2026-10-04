import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, appendFile, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAider, localTime, parseAiderFile, parseAiderSession, parseInputHistory, splitSessions } from '../src/aider.js';
import { defaultSourceDirs } from '../src/sources.js';
import { Store } from '../src/store.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'aider');
const HISTORY = path.join(FIX, 'shop', '.aider.chat.history.md');
// 履歴の時刻はローカル時刻なので、期待値もローカル時刻で作る
const local = (...a) => new Date(a[0], a[1] - 1, ...a.slice(2)).toISOString();

test('Aider の履歴を起動ごとのセッションに分ける', async () => {
  const entries = await listAider(FIX);
  // .venv などの中・起動行の無い履歴は対象外
  assert.deepEqual(entries.map((e) => e.file), [`${HISTORY}#2026-10-04 10:00:00`, `${HISTORY}#2026-10-05 09:00:00`]);
  const [a, b] = await Promise.all(entries.map((e) => parseAiderFile(e.file, e)));

  assert.equal(a.tool, 'aider');
  assert.match(a.id, /^aider-[0-9a-f]{24}$/);
  assert.notEqual(a.id, b.id);
  assert.equal(a.cwd, path.join(FIX, 'shop'));
  assert.equal(a.project, 'shop');
  // 複数行の依頼は1件、/add は数えず、/ask は中身を依頼にする
  assert.deepEqual(a.prompts, ['カートの合計金額のバグを直して。\n割引が二重に引かれている。', 'テストはどこにある？']);
  assert.equal(a.title, 'カートの合計金額のバグを直して。');
  assert.equal(a.assistantMessages, 2); // SEARCH/REPLACE の ">>>>>>> REPLACE" は応答の一部
  assert.deepEqual(a.models, ['anthropic/claude-sonnet-4-5-20250929']);
  assert.deepEqual(a.changedFiles, ['src/cart.py']);
  assert.deepEqual(a.commitList, [{ hash: '9f8e7d6', branch: null, subject: 'fix: apply cart discount once', at: local(2026, 10, 4, 10, 1, 5, 4) }]);
  assert.deepEqual(a.commands, ['git push']); // /run で打ったコマンド
  // 時刻: 起動と、入力履歴の各入力
  assert.equal(a.start, local(2026, 10, 4, 10, 0, 0));
  assert.equal(a.end, local(2026, 10, 4, 10, 20, 0));
  assert.equal(a.segments.length, 1);
  // "2.3k sent, 1.2k cache write" + "3.1k sent, 2.2k cache hit"(キャッシュ分は入力から除く)
  const hour = local(2026, 10, 4, 10, 1, 5, 4).slice(0, 13);
  assert.deepEqual(a.usage, { [`${hour}|anthropic/claude-sonnet-4-5-20250929||`]: [1100 + 900, 156 + 40, 2200, 1200, 0, 0] });

  assert.deepEqual(b.prompts, ['READMEに使い方を書いて']);
  assert.deepEqual(b.models, ['gpt-4o']);
  assert.equal(b.commits, 1);
  assert.equal(b.start, local(2026, 10, 5, 9, 0, 0));
});

test('部品: 起動の分割・入力履歴・ローカル時刻', () => {
  assert.equal(localTime('2026-10-04 10:00:20.120000'), new Date(2026, 9, 4, 10, 0, 20, 120).getTime());
  assert.ok(Number.isNaN(localTime('x')));
  assert.deepEqual(parseInputHistory('\n# 2026-10-04 10:00:00.5\n+a\n+b\n\n# 2026-10-04 10:01:00\n+/quit\n'), [
    { at: new Date(2026, 9, 4, 10, 0, 0, 500).getTime(), text: 'a\nb' },
    { at: new Date(2026, 9, 4, 10, 1, 0).getTime(), text: '/quit' },
  ]);
  const secs = splitSessions('前置き\n# aider chat started at 2026-10-04 10:00:00\n\n#### hi  \n\nhello\n');
  assert.equal(secs.length, 1);
  const s = parseAiderSession(secs[0], { file: '/r/.aider.chat.history.md' });
  assert.deepEqual(s.prompts, ['hi']);
  assert.equal(s.assistantMessages, 1);
  assert.equal(s.activeMs, 0); // 入力履歴が無ければ起動時刻だけ
});

test('Aider の履歴を Store で集め、追記された起動だけ読み直す', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-log-aider-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(FIX, 'shop'), path.join(root, 'repos', 'shop'), { recursive: true });
  await mkdir(path.join(root, 'cache'), { recursive: true });
  const dirs = [path.join(root, 'repos'), path.join(root, 'missing')].join(path.delimiter);
  const store = new Store({ projectsDir: path.join(root, 'none'), cacheDir: path.join(root, 'cache'), sourceDirs: { aider: dirs } });
  assert.equal((await store.scan()).total, 2);
  assert.deepEqual(store.sessions().map((s) => s.tool), ['aider', 'aider']);
  // 最後の起動に追記すると、その起動だけが変わる
  await appendFile(path.join(root, 'repos', 'shop', '.aider.chat.history.md'), '\n#### もう一つ  \n\nはい\n');
  const r = await store.scan();
  assert.equal(r.changed, 1);
  assert.equal(store.sessions().find((s) => s.prompts.includes('もう一つ')).userMessages, 2);
});

test('WORKLOG_AIDER_DIRS が無ければ読まない', () => {
  assert.equal(defaultSourceDirs({}, '/home/me').aider, null);
  assert.equal(defaultSourceDirs({ WORKLOG_AIDER_DIRS: '/a:/b' }, '/home/me').aider, '/a:/b');
  const store = new Store({ projectsDir: '/none', cacheDir: '/none', sourceDirs: defaultSourceDirs({}, '/home/me') });
  assert.equal(store.sourceDirs.aider, undefined);
});
