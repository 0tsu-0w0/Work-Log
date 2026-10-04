import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bubbleTime, defaultCursorDir, listCursor, loadSqlite, parseCursorComposer, parseCursorFile, uriToPath } from '../src/cursor.js';
import { Store } from '../src/store.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cursor');
const A = 'a1b2c3d4-0000-4000-8000-00000000000a';
const B = 'b1b2c3d4-0000-4000-8000-00000000000b';

// fixtures/cursor の JSON(キーと値の組)から、Cursor と同じ表の state.vscdb を作る
export async function buildCursorDir(root) {
  const { DatabaseSync } = await loadSqlite();
  const makeDb = (file, tables) => {
    const db = new DatabaseSync(file);
    for (const [table, rows] of Object.entries(tables)) {
      db.exec(`CREATE TABLE ${table} (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)`);
      const ins = db.prepare(`INSERT INTO ${table} (key, value) VALUES (?, ?)`);
      for (const [k, v] of Object.entries(rows)) ins.run(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    db.close();
  };
  await mkdir(path.join(root, 'globalStorage'), { recursive: true });
  makeDb(path.join(root, 'globalStorage', 'state.vscdb'), {
    ItemTable: {},
    cursorDiskKV: JSON.parse(await readFile(path.join(FIX, 'globalStorage', 'cursorDiskKV.json'), 'utf8')),
  });
  for (const ws of await readdir(path.join(FIX, 'workspaceStorage'))) {
    const dir = path.join(root, 'workspaceStorage', ws);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'workspace.json'), await readFile(path.join(FIX, 'workspaceStorage', ws, 'workspace.json')));
    makeDb(path.join(dir, 'state.vscdb'), { ItemTable: JSON.parse(await readFile(path.join(FIX, 'workspaceStorage', ws, 'ItemTable.json'), 'utf8')) });
  }
  return root;
}

const sqlite = await loadSqlite();
const skip = sqlite ? false : 'node:sqlite が使えない Node.js';

test('Cursor のチャット(新しい形式)をセッションに変換する', { skip }, async (t) => {
  const root = await buildCursorDir(await mkdtemp(path.join(os.tmpdir(), 'work-log-cursor-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = await listCursor(root);
  // 開いただけのチャットと壊れた composerData は一覧に出さない
  assert.deepEqual(entries.map((e) => e.composerId).sort(), [A, B]);
  const ea = entries.find((e) => e.composerId === A);
  assert.equal(ea.file, `${path.join(root, 'globalStorage', 'state.vscdb')}#${A}`);
  assert.equal(ea.mtimeMs, 1791093603000); // lastUpdatedAt
  assert.equal(ea.cwd, '/home/dev/site');

  const s = await parseCursorFile(ea.file, ea);
  assert.equal(s.tool, 'cursor');
  assert.equal(s.id, A);
  assert.equal(s.project, 'site');
  assert.equal(s.title, 'レスポンシブなヘッダー');
  assert.deepEqual(s.prompts, ['ヘッダーのナビゲーションをレスポンシブにして', 'ありがとう']);
  assert.equal(s.assistantMessages, 6);
  assert.deepEqual(s.models, ['claude-4.5-sonnet']);
  assert.deepEqual(s.toolCalls, { edit_file: 1, run_terminal_cmd: 2 });
  assert.deepEqual(s.changedFiles, ['src/Header.tsx']);
  assert.deepEqual(s.commitList.map((c) => [c.hash, c.branch, c.subject]), [['5e6f7a8', 'main', 'feat: responsive header']]);
  assert.equal(s.pushes, 0); // exitCode 128
  assert.equal(s.start, '2026-10-04T05:00:00.000Z');
  assert.equal(s.end, '2026-10-04T06:00:03.000Z');
  assert.equal(s.segments.length, 2);
  // 0 のままの tokenCount は数えない。単価の分からないモデル名なのでコストは「不明」になる
  assert.deepEqual(s.usage, { '2026-10-04T05|claude-4.5-sonnet||': [18000, 900, 0, 0, 0, 0] });

  // 古い形式(conversation に内包)・時刻は timingInfo、リモートのワークスペース
  const eb = entries.find((e) => e.composerId === B);
  assert.equal(eb.cwd, '/srv/api server');
  const b = await parseCursorFile(eb.file, eb);
  assert.deepEqual(b.prompts, ['API のエラー処理を共通化して']);
  assert.deepEqual(b.changedFiles, ['src/api/errors.ts']);
  assert.equal(b.start, new Date(1754038806000).toISOString());

  // entry 無しでも(ワークスペースを探して)読める
  assert.equal((await parseCursorFile(ea.file)).cwd, '/home/dev/site');
  await assert.rejects(parseCursorFile(`${ea.db}#no-such-composer`, {}));
});

test('Cursor のチャットを Store で集める(仮想のキーと更新時刻で差分を見る)', { skip }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-log-cursor-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await buildCursorDir(path.join(root, 'User'));
  await mkdir(path.join(root, 'cache'), { recursive: true });
  const store = new Store({ projectsDir: path.join(root, 'none'), cacheDir: path.join(root, 'cache'), sourceDirs: { cursor: path.join(root, 'User') } });
  const r = await store.scan();
  assert.equal(r.total, 2);
  assert.equal(r.changed, 2);
  assert.deepEqual(store.sessions().map((s) => [s.id, s.tool, s.project]), [[A, 'cursor', 'site'], [B, 'cursor', 'api server']]);
  assert.deepEqual(store.costs({ tool: 'cursor' }).unknownModels, ['claude-4.5-sonnet']);
  assert.equal((await store.scan()).changed, 0);
  // Cursor が無い環境では何もしない
  assert.deepEqual(await listCursor(path.join(root, 'none')), []);
});

test('部品: 既定の場所・URI・バブルの時刻', () => {
  assert.equal(defaultCursorDir({}, '/home/me', 'linux'), '/home/me/.config/Cursor/User');
  assert.equal(defaultCursorDir({}, '/Users/me', 'darwin'), '/Users/me/Library/Application Support/Cursor/User');
  assert.equal(defaultCursorDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me', 'win32'), path.join('C:\\Users\\me\\AppData\\Roaming', 'Cursor', 'User'));
  assert.equal(uriToPath('file:///home/me/my%20app'), '/home/me/my app');
  assert.equal(uriToPath('vscode-remote://wsl%2Bubuntu/home/me/app'), '/home/me/app');
  assert.equal(uriToPath(42), null);
  assert.equal(bubbleTime({ createdAt: '2026-10-04T00:00:00Z' }), Date.parse('2026-10-04T00:00:00Z'));
  assert.equal(bubbleTime({ timingInfo: { clientRpcSendTime: 1754038806000 } }), 1754038806000);
  assert.equal(bubbleTime({ timingInfo: { clientRpcSendTime: 1754038806 } }), null); // 秒は無視
  // バブルに時刻が無い古いチャットは作成・更新時刻を使う
  const s = parseCursorComposer({ composerId: 'x', createdAt: 1754038800000, lastUpdatedAt: 1754038900000 }, [{ type: 1, text: 'hi' }]);
  assert.equal(s.start, new Date(1754038800000).toISOString());
  assert.equal(s.end, new Date(1754038900000).toISOString());
});
