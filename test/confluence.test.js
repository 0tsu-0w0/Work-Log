import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Confluence } from '../src/confluence.js';
import { buildReport, periodRange } from '../src/report.js';
import { toConfluence } from '../src/docreport.js';
import { fakeFetch, setup, listen, one } from './doc-helpers.js';

const ENV = { CONFLUENCE_BASE_URL: 'https://example.atlassian.net/wiki', CONFLUENCE_EMAIL: 'me@example.com', CONFLUENCE_API_TOKEN: 'SECRETTOKEN', CONFLUENCE_SPACE_ID: '12345' };
const MSG = { kind: 'report', period: 'day', start: '2026-10-04', title: 'Work Log 日報 2026/10/4(日)', body: '<p>x</p>' };
const created = { id: '777', status: 'current', version: { number: 1 }, _links: { webui: '/spaces/WL/pages/777/Work+Log', base: 'https://example.atlassian.net/wiki' } };

test('Confluence Cloud のサイトと、必要な設定がそろったときだけ使える', () => {
  const c = (env, config) => new Confluence({ env: { ...ENV, ...env }, config });
  assert.equal(c({}).status().configured, true);
  assert.equal(c({ CONFLUENCE_BASE_URL: 'https://example.atlassian.net' }).baseUrl(), 'https://example.atlassian.net/wiki'); // /wiki を補う
  assert.equal(c({ CONFLUENCE_BASE_URL: 'https://example.atlassian.net/wiki/' }).baseUrl(), 'https://example.atlassian.net/wiki');
  assert.equal(c({ CONFLUENCE_BASE_URL: 'http://example.atlassian.net/wiki' }).status().configured, false);
  assert.equal(c({ CONFLUENCE_BASE_URL: 'https://example.atlassian.net.evil.example/wiki' }).status().configured, false);
  assert.equal(c({ CONFLUENCE_BASE_URL: 'https://example.atlassian.net/other' }).status().configured, false);
  assert.equal(c({ CONFLUENCE_BASE_URL: 'https://u:p@example.atlassian.net/wiki' }).status().configured, false);
  assert.equal(c({ CONFLUENCE_BASE_URL: 'http://127.0.0.1:9/wiki', WORKLOG_CONFLUENCE_BASE_ANY: '1' }).status().configured, true); // テスト用
  assert.equal(c({ CONFLUENCE_EMAIL: '' }).status().configured, false);
  assert.equal(c({ CONFLUENCE_API_TOKEN: '' }).status().configured, false);
  assert.equal(c({ CONFLUENCE_SPACE_ID: 'ABC' }).status().configured, false); // v2 は数字のスペース ID
  assert.equal(c({ CONFLUENCE_SPACE_ID: '' }, { spaceId: 999 }).spaceId(), '999'); // config.json でも指定できる
  assert.deepEqual(c({}).status(), { configured: true, mode: 'api', destination: 'example.atlassian.net(スペース 12345)', includeCost: false, notify: null });
  assert.doesNotMatch(JSON.stringify(c({}).status()), /SECRETTOKEN|me@example/);
});

test('作成: POST /api/v2/pages に storage format で送り、URL を返す', async (t) => {
  const f = fakeFetch([{ status: 200, body: created }]);
  const { cache } = await setup(t, { destinations: () => ({}), prefix: 'cf' });
  const c = new Confluence({ env: { ...ENV, CONFLUENCE_PARENT_ID: '55' }, fetchImpl: f.fetchImpl, cacheDir: cache });
  assert.deepEqual(await c.post(MSG), { url: 'https://example.atlassian.net/wiki/spaces/WL/pages/777/Work+Log', updated: false });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://example.atlassian.net/wiki/api/v2/pages');
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(f.calls[0].redirect, 'error');
  assert.ok(f.calls[0].signal);
  assert.equal(f.calls[0].headers.authorization, `Basic ${Buffer.from('me@example.com:SECRETTOKEN').toString('base64')}`);
  assert.deepEqual(JSON.parse(f.calls[0].body), { spaceId: '12345', status: 'current', title: MSG.title, parentId: '55', body: { representation: 'storage', value: '<p>x</p>' } });
  // 覚えたページの ID は、トークンを含まないファイルに残る
  const saved = await readFile(path.join(cache, 'confluence-pages.json'), 'utf8');
  assert.equal(JSON.parse(saved)['example.atlassian.net/12345|day:2026-10-04'].id, '777');
  assert.doesNotMatch(saved, /SECRETTOKEN/);
});

test('同じ期間を送り直すと、今のバージョン + 1 で同じページを更新する', async (t) => {
  const { cache } = await setup(t, { destinations: () => ({}), prefix: 'cf' });
  const f = fakeFetch([{ body: created }, { body: { ...created, version: { number: 4 } } }, { body: { ...created, version: { number: 5 } } }]);
  const mk = () => new Confluence({ env: ENV, fetchImpl: f.fetchImpl, cacheDir: cache });
  await mk().post(MSG);
  // 別のインスタンス(再起動後)でも、ファイルから同じページを見つける。画面で編集されてバージョンが 4 になっていても、5 で更新する
  const r = await mk().post({ ...MSG, body: '<p>y</p>' });
  assert.equal(r.updated, true);
  assert.equal(r.url, 'https://example.atlassian.net/wiki/spaces/WL/pages/777/Work+Log');
  assert.deepEqual(f.calls.slice(1).map((c) => `${c.method} ${c.url}`), ['GET https://example.atlassian.net/wiki/api/v2/pages/777', 'PUT https://example.atlassian.net/wiki/api/v2/pages/777']);
  assert.deepEqual(JSON.parse(f.calls[2].body), { id: '777', status: 'current', title: MSG.title, body: { representation: 'storage', value: '<p>y</p>' }, version: { number: 5, message: 'Work Log から更新' } });
  // 別の期間は別のページ
  const f2 = fakeFetch([{ body: { ...created, id: '888' } }]);
  const other = await new Confluence({ env: ENV, fetchImpl: f2.fetchImpl, cacheDir: cache }).post({ ...MSG, start: '2026-10-05' });
  assert.equal(other.updated, false);
  assert.equal(f2.calls[0].method, 'POST');
});

test('相手側でページが消えていたら(404・ゴミ箱)、作り直す', async () => {
  for (const gone of [{ status: 404, body: { errors: [{ status: 404, title: 'Not Found' }] } }, { body: { ...created, status: 'trashed' } }]) {
    const f = fakeFetch([{ body: created }, gone, { body: { ...created, id: '999' } }]);
    const c = new Confluence({ env: ENV, fetchImpl: f.fetchImpl }); // cacheDir なし: このプロセスの間だけ覚える
    await c.post(MSG);
    const r = await c.post(MSG);
    assert.equal(r.updated, false);
    assert.equal(f.calls.at(-1).method, 'POST');
  }
});

test('エラーと制限を伝える(トークンは含めない)', async () => {
  const run = (responses, msg = MSG) => new Confluence({ env: ENV, fetchImpl: fakeFetch(responses).fetchImpl }).post(msg);
  await assert.rejects(run([{ status: 429, headers: { 'retry-after': '7' } }]), /7秒後/);
  await assert.rejects(run([{ status: 401, body: { message: 'Unauthorized' } }]), /Confluence 401: Unauthorized/);
  await assert.rejects(run([{ status: 400, body: { errors: [{ status: 400, code: 'BAD', title: 'A page with this title already exists', detail: 'タイトルが重複しています' }] } }]), /Confluence 400: タイトルが重複しています/);
  await assert.rejects(run([{ status: 200, body: {} }]), /ID を読めません/);
  await assert.rejects(new Confluence({ env: {} }).post(MSG), /CONFLUENCE_BASE_URL/);
  await assert.rejects(run([{ body: created }], { ...MSG, kind: 'session' }), /日報・週報だけ/);
  await assert.rejects(new Confluence({ env: ENV, fetchImpl: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); } }).post(MSG), /タイムアウト/);
  try {
    await run([{ status: 500, body: { message: 'boom' } }]);
  } catch (err) {
    assert.doesNotMatch(err.message, /SECRETTOKEN/);
  }
});

test('日報を Confluence に送る(プレビューと同じ内容だけ、秘匿情報は伏せる)', async (t) => {
  const f = fakeFetch([{ body: created }]);
  const { store, cache } = await setup(t, { destinations: (cacheDir) => ({ confluence: new Confluence({ env: ENV, fetchImpl: f.fetchImpl, cacheDir }) }), prefix: 'cf' });
  const date = new Date().toISOString().slice(0, 10);
  const r = await store.report({ target: 'confluence', period: 'day', date, tz: 'UTC' });
  assert.equal(r.target, 'confluence');
  assert.equal(r.message.kind, 'report');
  assert.equal(r.message.start, date);
  assert.ok(r.preview.includes('\\[GITHUB\\_TOKEN\\]') || r.preview.includes('[GITHUB_TOKEN]'), r.preview);
  assert.doesNotMatch(r.preview, /ghp/);
  assert.ok(r.message.body.includes('[GITHUB_TOKEN]'), r.message.body);
  await assert.rejects(store.postReport({ target: 'confluence', period: 'day', date, tz: 'UTC' }, 'wrong'), /内容が変わりました/);
  const sent = await store.postReport({ target: 'confluence', period: 'day', date, tz: 'UTC' }, r.hash);
  assert.match(sent.url, /^https:\/\/example\.atlassian\.net\/wiki\/spaces\//);
  const body = JSON.parse(f.calls.at(-1).body);
  assert.deepEqual(Object.keys(body), ['spaceId', 'status', 'title', 'body']); // プレビュー用の文字列は送らない
  assert.doesNotMatch(f.calls.at(-1).body, /ghp_abcdefghij/);
  // もう一度送ると更新になる(Store が cacheDir を渡している)
  f.calls.length = 0;
  const again = await store.postReport({ target: 'confluence', period: 'day', date, tz: 'UTC' }, r.hash);
  assert.equal(again.updated, true);
  assert.equal(f.calls[0].method, 'GET');

  const base = await listen(t, store);
  const pv = await (await fetch(`${base}/api/report?target=confluence&period=week&date=${date}&tz=UTC`)).json();
  assert.equal(pv.target, 'confluence');
  assert.doesNotMatch(pv.previewText, /\\|^#|\*\*/m);
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.confluence.configured, true);
  const d = cfg.destinations.find((x) => x.name === 'confluence');
  assert.equal(d.label, 'Confluence');
  assert.match(d.note, /スペース/);
  assert.equal(JSON.stringify(cfg).includes('SECRETTOKEN'), false);
  assert.equal(JSON.stringify(cfg).includes('me@example.com'), false);
  // 週報は別のページ(週の開始日が違う)
  const res = await fetch(`${base}/api/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'confluence', period: 'week', date, tz: 'UTC', hash: pv.hash }) });
  assert.equal(res.status, 200);
  assert.equal(f.calls.at(-1).method, 'POST');
  assert.ok(Object.keys(JSON.parse(await readFile(path.join(cache, 'confluence-pages.json'), 'utf8'))).some((k) => k.includes('|week:')));
});

test('セッション終了の通知は送らない(sessionEnd が無い)', async (t) => {
  const f = fakeFetch([{ body: created }]);
  const { store } = await setup(t, { config: { confluence: { notify: 'session_end' } }, destinations: (cacheDir) => ({ confluence: new Confluence({ env: ENV, fetchImpl: f.fetchImpl, cacheDir }) }), prefix: 'cf' });
  await store.loadConfig();
  assert.equal(await store.notifySessionEnds(), 0);
  assert.equal(f.calls.length, 0);
  assert.equal(store.destinations.confluence.status().notify, null);
});

test('formatter は Store を通さなくても同じ message を返す', () => {
  const m = toConfluence(buildReport({ sessions: [one(1)], range: periodRange({ period: 'day', date: '2026-10-04', timeZone: 'UTC' }) }));
  assert.deepEqual([m.kind, m.period, m.start], ['report', 'day', '2026-10-04']);
});
