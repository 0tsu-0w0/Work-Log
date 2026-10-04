import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Obsidian } from '../src/obsidian.js';
import { setup, listen } from './doc-helpers.js';

const MSG = { kind: 'report', period: 'day', start: '2026-10-04', title: 'Work Log 日報 2026-10-04(日)', body: '---\ndate: 2026-10-04\n---\n\n本文\n' };

async function vault(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'work-log-vault-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('Vault は存在する絶対パスだけ、フォルダは Vault の中の相対パスだけを受け付ける', async (t) => {
  const v = await vault(t);
  const o = (env, config) => new Obsidian({ env: { OBSIDIAN_VAULT_DIR: v, ...env }, config });
  assert.equal(o({}).status().configured, true);
  assert.deepEqual(o({}).status(), { configured: true, mode: 'file', destination: `${path.basename(v)}/Work Log`, includeCost: false, notify: null });
  assert.equal(o({ OBSIDIAN_VAULT_DIR: '' }).status().configured, false);
  assert.equal(o({ OBSIDIAN_VAULT_DIR: '' }, { vault: v }).status().configured, true); // config.json でも指定できる
  assert.equal(o({ OBSIDIAN_VAULT_DIR: path.join(v, 'nothing') }).status().configured, false);
  assert.equal(o({ OBSIDIAN_VAULT_DIR: 'relative/dir' }).status().configured, false);
  assert.equal(o({}, { folder: 'a/b' }).folder(), 'a/b');
  assert.equal(o({}, { folder: ' a // b/ ' }).folder(), 'a/b');
  for (const bad of ['..', '../x', 'a/../b', 'a..b', '/abs', '.obsidian', 'a/.hidden', 'a\\b', 'a\0b', 'a:b']) {
    assert.equal(o({}, { folder: bad }).folder(), null, bad);
    assert.equal(o({}, { folder: bad }).status().configured, false, bad);
  }
  assert.equal(o({}, { folder: '' }).folder(), 'Work Log');
  assert.equal(o({}, { folder: 5 }).folder(), null);
});

test('日報・週報を Vault のフォルダに書き、同じ期間は上書きする', async (t) => {
  const v = await vault(t);
  const o = new Obsidian({ env: { OBSIDIAN_VAULT_DIR: v }, config: { folder: 'Notes/Work Log' } });
  const r = await o.post(MSG);
  assert.equal(r.updated, false);
  assert.equal(r.url, `obsidian://open?vault=${encodeURIComponent(path.basename(v))}&file=${encodeURIComponent('Notes/Work Log/2026-10-04 日報')}`);
  const file = path.join(v, 'Notes', 'Work Log', '2026-10-04 日報.md');
  assert.equal(await readFile(file, 'utf8'), MSG.body);
  const r2 = await o.post({ ...MSG, body: '更新\n' });
  assert.equal(r2.updated, true);
  assert.equal(await readFile(file, 'utf8'), '更新\n');
  assert.deepEqual(await readdir(path.join(v, 'Notes', 'Work Log')), ['2026-10-04 日報.md']); // 一時ファイルは残らない
  await o.post({ ...MSG, period: 'week', start: '2026-09-28' });
  assert.ok((await readdir(path.join(v, 'Notes', 'Work Log'))).includes('2026-W40 週報.md'));
});

test('書き込み先が Vault の外になるものは書かない', async (t) => {
  const v = await vault(t);
  const outside = await vault(t);
  // フォルダの指定
  for (const folder of ['../escape', 'a/../../escape', '/etc']) {
    await assert.rejects(new Obsidian({ env: { OBSIDIAN_VAULT_DIR: v }, config: { folder } }).post(MSG), /フォルダの指定が正しくありません/);
  }
  // Vault の中のシンボリックリンクが外を指しているとき
  await symlink(outside, path.join(v, 'link'));
  await assert.rejects(new Obsidian({ env: { OBSIDIAN_VAULT_DIR: v }, config: { folder: 'link' } }).post(MSG), /Vault の外/);
  await assert.rejects(new Obsidian({ env: { OBSIDIAN_VAULT_DIR: v }, config: { folder: 'link/sub' } }).post(MSG), /Vault の外/);
  assert.deepEqual(await readdir(outside), []);
  // ノートの場所がシンボリックリンクのとき
  await mkdir(path.join(v, 'Work Log'));
  await writeFile(path.join(outside, 'target.md'), 'そのまま');
  await symlink(path.join(outside, 'target.md'), path.join(v, 'Work Log', '2026-10-04 日報.md'));
  await assert.rejects(new Obsidian({ env: { OBSIDIAN_VAULT_DIR: v } }).post(MSG), /書きません/);
  assert.equal(await readFile(path.join(outside, 'target.md'), 'utf8'), 'そのまま');
  // 期間は日付の形だけ(ファイル名に本文の値を使わない)
  await assert.rejects(new Obsidian({ env: { OBSIDIAN_VAULT_DIR: v } }).post({ ...MSG, start: '../../x' }), /日報・週報だけ/);
  await assert.rejects(new Obsidian({ env: { OBSIDIAN_VAULT_DIR: v } }).post({ kind: 'session', date: '../x', line: '- a' }), /形が正しくありません/);
  await assert.rejects(new Obsidian({ env: {} }).post(MSG), /OBSIDIAN_VAULT_DIR/);
});

test('セッション終了: <日付> セッション.md に1行ずつ足す', async (t) => {
  const v = await vault(t);
  const o = new Obsidian({ env: { OBSIDIAN_VAULT_DIR: v } });
  const r = await o.post({ kind: 'session', date: '2026-10-04', line: '- 10:00 作業 — web・25分・1コミット\n- 悪い行' });
  assert.match(r.url, /file=Work%20Log%2F2026-10-04%20%E3%82%BB%E3%83%83%E3%82%B7%E3%83%A7%E3%83%B3$/);
  await o.post({ kind: 'session', date: '2026-10-04', line: '- 11:00 別の作業' });
  const text = await readFile(path.join(v, 'Work Log', '2026-10-04 セッション.md'), 'utf8');
  assert.equal(text, '---\ndate: 2026-10-04\ntags: [work-log]\n---\n\n- 10:00 作業 — web・25分・1コミット - 悪い行\n- 11:00 別の作業\n');
});

test('日報を Obsidian に書く(プレビューと同じ内容だけ、秘匿情報は伏せる)', async (t) => {
  const v = await vault(t);
  const { store } = await setup(t, { destinations: () => ({ obsidian: new Obsidian({ env: { OBSIDIAN_VAULT_DIR: v } }) }), prefix: 'obs' });
  const date = new Date().toISOString().slice(0, 10);
  const r = await store.report({ target: 'obsidian', period: 'day', date, tz: 'UTC' });
  assert.equal(r.target, 'obsidian');
  assert.doesNotMatch(r.preview, /ghp/);
  const sent = await store.postReport({ target: 'obsidian', period: 'day', date, tz: 'UTC' }, r.hash);
  assert.match(sent.url, /^obsidian:\/\/open\?vault=/);
  const text = await readFile(path.join(v, 'Work Log', `${date} 日報.md`), 'utf8');
  assert.ok(text.startsWith(`---\ndate: ${date}\nperiod: day\ntags: [work-log]\n---\n`), text);
  assert.ok(text.includes('\\[GITHUB\\_TOKEN\\]'), text);
  assert.doesNotMatch(text, /ghp_abcdefghij/);

  const base = await listen(t, store);
  const pv = await (await fetch(`${base}/api/report?target=obsidian&period=week&date=${date}&tz=UTC`)).json();
  assert.equal(pv.target, 'obsidian');
  assert.doesNotMatch(pv.previewText, /\\|^#/m);
  const res = await fetch(`${base}/api/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'obsidian', period: 'week', date, tz: 'UTC', hash: pv.hash }) });
  assert.equal(res.status, 200);
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.obsidian.configured, true);
  assert.equal(cfg.destinations.find((x) => x.name === 'obsidian').label, 'Obsidian');
});

test('セッション終了の通知(Obsidian)は1回だけ', async (t) => {
  const v = await vault(t);
  const { root, store, now } = await setup(t, { config: { obsidian: { notify: 'session_end' } }, destinations: () => ({ obsidian: new Obsidian({ env: { OBSIDIAN_VAULT_DIR: v } }) }), prefix: 'obs' });
  const ev = (event, minutesAgo) => JSON.stringify({ ts: new Date(now - minutesAgo * 60000).toISOString(), event, sessionId: 's1' }) + '\n';
  await writeFile(path.join(root, 'cache', 'events.jsonl'), ev('SessionEnd', 5));
  await store.scan();
  assert.equal(await store.notifySessionEnds(), 1);
  const [name] = (await readdir(path.join(v, 'Work Log'))).filter((n) => n.endsWith('セッション.md'));
  const text = await readFile(path.join(v, 'Work Log', name), 'utf8');
  assert.match(text, /\n- \d\d:\d\d \\\[GITHUB\\_TOKEN\\\] を使う修正 — web・/);
  assert.equal(await store.notifySessionEnds(), 0);
  assert.equal((await readFile(path.join(v, 'Work Log', name), 'utf8')).split('\n- ').length, 2);
});
