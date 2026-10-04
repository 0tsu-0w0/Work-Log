import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { QiitaTeam } from '../src/qiitateam.js';
import { fakeFetch, setup, listen } from './doc-helpers.js';

const ENV = { QIITA_TEAM_DOMAIN: 'myteam.qiita.com', QIITA_ACCESS_TOKEN: 'SECRETTOKEN' };
const MSG = { kind: 'report', period: 'day', start: '2026-10-04', title: 'Work Log 日報 2026-10-04(日)', body: '## 見出し\n\n本文' };
const item = (id = 'c686397e4a0f4f11683d') => ({ status: 201, body: { id, title: MSG.title, url: `https://myteam.qiita.com/me/items/${id}` } });

test('<チーム名>.qiita.com だけを受け付ける(qiita.com 本体には送らない)', () => {
  const q = (domain, token = 'T') => new QiitaTeam({ env: { QIITA_TEAM_DOMAIN: domain, QIITA_ACCESS_TOKEN: token } });
  assert.equal(q('myteam.qiita.com').status().configured, true);
  assert.equal(q('https://MyTeam.qiita.com/').host(), 'myteam.qiita.com');
  for (const bad of ['qiita.com', 'www.qiita.com', 'api.qiita.com', 'a.b.qiita.com', 'myteam.qiita.com.evil.example', 'myteam.qiita.com@evil.example', 'evil.example', 'myteam.qiita.com/x', 'http://myteam.qiita.com', '']) {
    assert.equal(q(bad).status().configured, false, bad);
  }
  assert.equal(q('myteam.qiita.com', '').status().configured, false);
  assert.deepEqual(q('myteam.qiita.com').status(), { configured: true, mode: 'api', destination: 'myteam.qiita.com', includeCost: false, notify: null });
  assert.doesNotMatch(JSON.stringify(q('myteam.qiita.com').status()), /"T"/);
});

test('作成: POST /api/v2/items にタグ付きで送り、URL を返す', async (t) => {
  const f = fakeFetch([item()]);
  const { cache } = await setup(t, { destinations: () => ({}), prefix: 'qt' });
  const q = new QiitaTeam({ env: ENV, fetchImpl: f.fetchImpl, cacheDir: cache });
  assert.deepEqual(await q.post(MSG), { url: 'https://myteam.qiita.com/me/items/c686397e4a0f4f11683d', updated: false });
  assert.equal(f.calls[0].url, 'https://myteam.qiita.com/api/v2/items');
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(f.calls[0].redirect, 'error');
  assert.ok(f.calls[0].signal);
  assert.equal(f.calls[0].headers.authorization, 'Bearer SECRETTOKEN');
  assert.deepEqual(JSON.parse(f.calls[0].body), { title: MSG.title, body: MSG.body, tags: [{ name: '日報', versions: [] }], private: false });
  await q.post({ ...MSG, period: 'week', start: '2026-09-28' });
  assert.deepEqual(JSON.parse(f.calls[1].body).tags, [{ name: '週報', versions: [] }]);
  const saved = await readFile(path.join(cache, 'qiitateam-pages.json'), 'utf8');
  assert.equal(JSON.parse(saved)['myteam.qiita.com|day:2026-10-04'].id, 'c686397e4a0f4f11683d');
  assert.doesNotMatch(saved, /SECRETTOKEN/);
  // タグは config.json で置き換えられる(5個まで)
  const f2 = fakeFetch([item('a')]);
  await new QiitaTeam({ env: ENV, config: { tags: ['x', 'y', '', 3, 'z', 'a', 'b', 'c'] }, fetchImpl: f2.fetchImpl }).post(MSG);
  assert.deepEqual(JSON.parse(f2.calls[0].body).tags.map((x) => x.name), ['x', 'y', 'z', 'a', 'b']);
});

test('同じ期間を送り直すと、同じ記事を PATCH で更新する', async (t) => {
  const { cache } = await setup(t, { destinations: () => ({}), prefix: 'qt' });
  const f = fakeFetch([item(), { status: 200, body: { id: 'c686397e4a0f4f11683d', url: 'https://myteam.qiita.com/me/items/c686397e4a0f4f11683d' } }]);
  await new QiitaTeam({ env: ENV, fetchImpl: f.fetchImpl, cacheDir: cache }).post(MSG);
  const r = await new QiitaTeam({ env: ENV, fetchImpl: f.fetchImpl, cacheDir: cache }).post({ ...MSG, body: '更新' });
  assert.equal(r.updated, true);
  assert.equal(f.calls[1].method, 'PATCH');
  assert.equal(f.calls[1].url, 'https://myteam.qiita.com/api/v2/items/c686397e4a0f4f11683d');
  assert.equal(JSON.parse(f.calls[1].body).body, '更新');
  // 消されていたら(404)作り直す
  const f2 = fakeFetch([{ status: 404, body: { message: 'Not found', type: 'not_found' } }, item('ffff')]);
  const again = await new QiitaTeam({ env: ENV, fetchImpl: f2.fetchImpl, cacheDir: cache }).post(MSG);
  assert.equal(again.updated, false);
  assert.deepEqual(f2.calls.map((c) => c.method), ['PATCH', 'POST']);
});

test('エラーと制限を伝える(トークンは含めない)', async () => {
  const run = (r, msg = MSG) => new QiitaTeam({ env: ENV, fetchImpl: fakeFetch([r]).fetchImpl }).post(msg);
  await assert.rejects(run({ status: 429, headers: { 'retry-after': '60' } }), /60秒後/);
  await assert.rejects(run({ status: 401, body: { message: 'Unauthorized', type: 'unauthorized' } }), /Qiita Team 401: Unauthorized/);
  await assert.rejects(run({ status: 400, body: { type: 'bad_request' } }), /Qiita Team 400: bad_request/);
  await assert.rejects(run({ status: 201, body: {} }), /ID を読めません/);
  await assert.rejects(new QiitaTeam({ env: {} }).post(MSG), /QIITA_TEAM_DOMAIN/);
  await assert.rejects(run(item(), { ...MSG, kind: 'session' }), /日報・週報だけ/);
  await assert.rejects(new QiitaTeam({ env: ENV, fetchImpl: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); } }).post(MSG), /タイムアウト/);
});

test('日報を Qiita Team に送る(プレビューと同じ内容だけ、秘匿情報は伏せる)', async (t) => {
  const f = fakeFetch([item()]);
  const { store } = await setup(t, { destinations: (cacheDir) => ({ qiitateam: new QiitaTeam({ env: ENV, fetchImpl: f.fetchImpl, cacheDir }) }), prefix: 'qt' });
  const date = new Date().toISOString().slice(0, 10);
  const r = await store.report({ target: 'qiitateam', period: 'day', date, tz: 'UTC' });
  assert.equal(r.target, 'qiitateam');
  assert.doesNotMatch(r.preview, /ghp/);
  const sent = await store.postReport({ target: 'qiitateam', period: 'day', date, tz: 'UTC' }, r.hash);
  assert.match(sent.url, /^https:\/\/myteam\.qiita\.com\//);
  assert.deepEqual(Object.keys(JSON.parse(f.calls.at(-1).body)), ['title', 'body', 'tags', 'private']); // プレビュー用の文字列は送らない
  assert.doesNotMatch(f.calls.at(-1).body, /ghp_abcdefghij/);
  assert.ok(JSON.parse(f.calls.at(-1).body).body.includes('\\[GITHUB\\_TOKEN\\]'));

  const base = await listen(t, store);
  const pv = await (await fetch(`${base}/api/report?target=qiitateam&period=week&date=${date}&tz=UTC`)).json();
  assert.equal(pv.target, 'qiitateam');
  assert.doesNotMatch(pv.previewText, /\\|^#/m);
  const res = await fetch(`${base}/api/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'qiitateam', period: 'week', date, tz: 'UTC', hash: pv.hash }) });
  assert.equal(res.status, 200);
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.qiitateam.configured, true);
  const d = cfg.destinations.find((x) => x.name === 'qiitateam');
  assert.equal(d.label, 'Qiita Team');
  assert.equal(JSON.stringify(cfg).includes('SECRETTOKEN'), false);
});
