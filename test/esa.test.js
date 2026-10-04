import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Esa } from '../src/esa.js';
import { Store } from '../src/store.js';
import { fakeFetch, setup, listen } from './doc-helpers.js';

const ENV = { ESA_ACCESS_TOKEN: 'SECRETTOKEN', ESA_TEAM: 'myteam' };
const MSG = { kind: 'report', period: 'day', start: '2026-10-04', title: 'Work Log 日報 2026-10-04(日)', body: '## 見出し\n\n本文' };
const post = (n = 12) => ({ status: 201, body: { number: n, name: MSG.title, url: `https://myteam.esa.io/posts/${n}`, revision_number: 1 } });

test('チーム名とアクセストークンがそろったときだけ使える', () => {
  const e = (env, config) => new Esa({ env: { ...ENV, ...env }, config });
  assert.equal(e({}).status().configured, true);
  assert.equal(e({ ESA_TEAM: '' }).status().configured, false);
  assert.equal(e({ ESA_TEAM: '' }, { team: 'fromconfig' }).team(), 'fromconfig');
  assert.equal(e({ ESA_TEAM: 'a/../b' }).status().configured, false); // URL に混ぜられない
  assert.equal(e({ ESA_TEAM: 'a.evil.example' }).status().configured, false);
  assert.equal(e({ ESA_ACCESS_TOKEN: '' }).status().configured, false);
  assert.deepEqual(e({}).status(), { configured: true, mode: 'api', destination: 'myteam.esa.io', includeCost: false, notify: null });
  assert.doesNotMatch(JSON.stringify(e({}).status()), /SECRETTOKEN/);
});

test('カテゴリ: 既定は 日報 / 週報 ごと、%{year} などは開始日で置き換える', () => {
  const e = (category) => new Esa({ env: ENV, config: { category } });
  assert.equal(e().category(MSG), 'Work Log/日報');
  assert.equal(e().category({ ...MSG, period: 'week' }), 'Work Log/週報');
  assert.equal(e('日報/%{year}/%{month}').category(MSG), '日報/2026/10');
  assert.equal(e('/Log//%{kind}/%{year}-%{month}-%{day}/').category({ ...MSG, period: 'week' }), 'Log/週報/2026-10-04');
  assert.equal(e('x/%{unknown}').category(MSG), 'x/%{unknown}');
});

test('作成: POST /v1/teams/{team}/posts に { post } を送り、URL を返す', async (t) => {
  const f = fakeFetch([post()]);
  const { cache } = await setup(t, { destinations: () => ({}), prefix: 'esa' });
  const e = new Esa({ env: ENV, fetchImpl: f.fetchImpl, cacheDir: cache });
  assert.deepEqual(await e.post(MSG), { url: 'https://myteam.esa.io/posts/12', updated: false });
  assert.equal(f.calls[0].url, 'https://api.esa.io/v1/teams/myteam/posts');
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(f.calls[0].redirect, 'error');
  assert.ok(f.calls[0].signal);
  assert.equal(f.calls[0].headers.authorization, 'Bearer SECRETTOKEN');
  assert.deepEqual(JSON.parse(f.calls[0].body), { post: { name: MSG.title, category: 'Work Log/日報', body_md: MSG.body, message: 'Work Log から送信', wip: false } });
  const saved = await readFile(path.join(cache, 'esa-pages.json'), 'utf8');
  assert.equal(JSON.parse(saved)['myteam|day:2026-10-04'].id, 12);
  assert.doesNotMatch(saved, /SECRETTOKEN/);
});

test('同じ期間を送り直すと、同じ記事を PATCH で更新する(wip は下書きにしたいときだけ送る)', async (t) => {
  const { cache } = await setup(t, { destinations: () => ({}), prefix: 'esa' });
  const f = fakeFetch([post(), { status: 200, body: { number: 12, url: 'https://myteam.esa.io/posts/12' } }]);
  await new Esa({ env: ENV, fetchImpl: f.fetchImpl, cacheDir: cache }).post(MSG);
  const r = await new Esa({ env: ENV, fetchImpl: f.fetchImpl, cacheDir: cache }).post({ ...MSG, body: '更新' });
  assert.deepEqual(r, { url: 'https://myteam.esa.io/posts/12', updated: true });
  assert.equal(f.calls[1].method, 'PATCH');
  assert.equal(f.calls[1].url, 'https://api.esa.io/v1/teams/myteam/posts/12');
  const sent = JSON.parse(f.calls[1].body).post;
  assert.equal(sent.body_md, '更新');
  assert.equal('wip' in sent, false);
  // wip: true の設定なら、更新でも下書きのまま
  const f2 = fakeFetch([{ status: 200, body: { number: 12, url: 'u' } }]);
  await new Esa({ env: ENV, config: { wip: true }, fetchImpl: f2.fetchImpl, cacheDir: cache }).post(MSG);
  assert.equal(JSON.parse(f2.calls[0].body).post.wip, true);
  // 記事が消されていたら(404)作り直す
  const f3 = fakeFetch([{ status: 404, body: { error: 'not_found', message: 'Not found' } }, post(30)]);
  const again = await new Esa({ env: ENV, fetchImpl: f3.fetchImpl, cacheDir: cache }).post(MSG);
  assert.equal(again.updated, false);
  assert.deepEqual(f3.calls.map((c) => c.method), ['PATCH', 'POST']);
  assert.equal(JSON.parse(await readFile(path.join(cache, 'esa-pages.json'), 'utf8'))['myteam|day:2026-10-04'].id, 30);
});

test('エラーと制限を伝える(トークンは含めない)', async () => {
  const run = (r, msg = MSG) => new Esa({ env: ENV, fetchImpl: fakeFetch([r]).fetchImpl }).post(msg);
  await assert.rejects(run({ status: 429, headers: { 'retry-after': '30' } }), /30秒後/);
  await assert.rejects(run({ status: 401, body: { error: 'unauthorized', message: 'Unauthorized' } }), /esa 401: Unauthorized/);
  await assert.rejects(run({ status: 422, body: { error: 'unprocessable_entity', message: 'Name has already been taken' } }), /esa 422: Name has already been taken/);
  await assert.rejects(run({ status: 201, body: {} }), /番号を読めません/);
  await assert.rejects(new Esa({ env: {} }).post(MSG), /ESA_ACCESS_TOKEN/);
  await assert.rejects(run(post(), { ...MSG, start: 'x' }), /日報・週報だけ/);
  await assert.rejects(new Esa({ env: ENV, fetchImpl: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); } }).post(MSG), /タイムアウト/);
});

test('日報を esa に送る(プレビューと同じ内容だけ、秘匿情報は伏せる)', async (t) => {
  const f = fakeFetch([post(), { status: 200, body: { number: 12, url: 'https://myteam.esa.io/posts/12' } }]);
  const { store, root } = await setup(t, { destinations: (cacheDir) => ({ esa: new Esa({ env: ENV, fetchImpl: f.fetchImpl, cacheDir }) }), prefix: 'esa' });
  // Store は cacheDir を渡して送り先を作る
  assert.equal(new Store({ projectsDir: path.join(root, 'projects'), cacheDir: path.join(root, 'c2') }).destinations.esa.pages.file, path.join(root, 'c2', 'esa-pages.json'));
  const date = new Date().toISOString().slice(0, 10);
  const r = await store.report({ target: 'esa', period: 'day', date, tz: 'UTC' });
  assert.equal(r.target, 'esa');
  assert.doesNotMatch(r.preview, /ghp/);
  assert.ok(r.message.body.includes('\\[GITHUB\\_TOKEN\\]'), r.message.body);
  const sent = await store.postReport({ target: 'esa', period: 'day', date, tz: 'UTC' }, r.hash);
  assert.equal(sent.url, 'https://myteam.esa.io/posts/12');
  const body = JSON.parse(f.calls.at(-1).body);
  assert.deepEqual(Object.keys(body.post), ['name', 'category', 'body_md', 'message', 'wip']); // プレビュー用の文字列は送らない
  assert.doesNotMatch(f.calls.at(-1).body, /ghp_abcdefghij/);
  assert.equal((await store.postReport({ target: 'esa', period: 'day', date, tz: 'UTC' }, r.hash)).updated, true);

  const base = await listen(t, store);
  const pv = await (await fetch(`${base}/api/report?target=esa&period=week&date=${date}&tz=UTC`)).json();
  assert.equal(pv.target, 'esa');
  assert.doesNotMatch(pv.previewText, /\\|^#/m);
  const res = await fetch(`${base}/api/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'esa', period: 'week', date, tz: 'UTC', hash: pv.hash }) });
  assert.equal(res.status, 200);
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.esa.configured, true);
  assert.equal(cfg.destinations.find((x) => x.name === 'esa').env, 'ESA_ACCESS_TOKEN');
  assert.equal(JSON.stringify(cfg).includes('SECRETTOKEN'), false);
});
