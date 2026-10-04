import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, fingerprint } from '../src/store.js';
import { createServer } from '../src/server.js';
import { SYNCS } from '../src/sync/index.js';
import { GoogleCalendar } from '../src/sync/gcal.js';
import { Toggl } from '../src/sync/toggl.js';
import { Clockify } from '../src/sync/clockify.js';
import { Harvest } from '../src/sync/harvest.js';

const API = 'http://fake.test';
const SECRETS = {
  GOOGLE_CLIENT_ID: 'cid.apps.example', GOOGLE_CLIENT_SECRET: 'GSECRET-xyz', GOOGLE_REFRESH_TOKEN: 'GREFRESH-xyz', GOOGLE_CALENDAR_ID: 'worklog-cal',
  TOGGL_API_TOKEN: 'TOGGLTOKEN123', CLOCKIFY_API_KEY: 'CLOCKIFYKEY123', HARVEST_ACCESS_TOKEN: 'HARVESTTOKEN123', HARVEST_ACCOUNT_ID: '4242',
};
const ENV = {
  ...SECRETS,
  WORKLOG_GCAL_API: `${API}/gcal`, WORKLOG_GCAL_TOKEN_URL: `${API}/token`,
  WORKLOG_TOGGL_API: `${API}/toggl`, WORKLOG_CLOCKIFY_API: `${API}/clockify`, WORKLOG_HARVEST_API: `${API}/harvest`,
};

// 4つのサービスの API を真似る。作られた記録を覚え、無い ID の更新・削除には 404 を返す
function fakeApi() {
  const calls = [];
  const items = new Map();
  let n = 0;
  let fail = null; // { status, headers } を1回だけ返す
  const json = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const fetchImpl = async (url, o = {}) => {
    const u = new URL(url);
    const method = o.method || 'GET';
    const ct = o.headers?.['content-type'] || '';
    const body = o.body ? (ct.includes('json') ? JSON.parse(o.body) : Object.fromEntries(new URLSearchParams(o.body))) : undefined;
    calls.push({ url: u.href, path: u.pathname, method, headers: o.headers, body, redirect: o.redirect });
    if (fail) {
      const f = fail;
      fail = null;
      return json(f.status, { message: 'too many' }, f.headers);
    }
    if (u.pathname === '/token') return json(200, { access_token: `AT${calls.length}`, expires_in: 3599, token_type: 'Bearer' });
    if (u.pathname === '/toggl/me') return json(200, { id: 1, default_workspace_id: 777 });
    if (u.pathname === '/clockify/user') return json(200, { id: 'u1', activeWorkspace: 'ws-active', defaultWorkspace: 'ws-default' });
    const m = u.pathname.match(/^(.*?)(?:\/([^/]+))?$/);
    if (method === 'POST') {
      const id = `${u.pathname.split('/')[1]}-${++n}`;
      items.set(id, body);
      return json(200, { id: u.pathname.startsWith('/toggl') || u.pathname.startsWith('/harvest') ? n : id });
    }
    const id = decodeURIComponent(m[2]);
    const key = [...items.keys()].find((k) => k === id || k.endsWith(`-${id}`));
    if (!key) return json(404, { message: 'not found' });
    if (method === 'DELETE') {
      items.delete(key);
      return new Response(null, { status: 204 });
    }
    items.set(key, body);
    return json(200, { id });
  };
  return { calls, items, fetchImpl, failNext: (status, headers = {}) => (fail = { status, headers }) };
}

function clients(fetchImpl, env = ENV) {
  const o = { env, fetchImpl, minIntervalMs: 0 };
  return { gcal: new GoogleCalendar(o), toggl: new Toggl(o), clockify: new Clockify(o), harvest: new Harvest(o) };
}

const line = (id, o) => JSON.stringify({ sessionId: id, cwd: '/nonexistent/web', ...o });
const user = (id, at, content) => line(id, { type: 'user', timestamp: at, message: { role: 'user', content } });
const asst = (id, at) => line(id, { type: 'assistant', timestamp: at, message: { id: `a${at}`, model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [] } });

async function setup(t, { config = { harvest: { projectId: 11, taskId: 22, timeZone: 'Asia/Tokyo' } } } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-log-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proj = path.join(root, 'projects', '-web');
  await mkdir(proj, { recursive: true });
  await mkdir(path.join(root, 'cache'), { recursive: true });
  await writeFile(path.join(root, 'cache', 'config.json'), JSON.stringify(config));
  const now = Date.now();
  const iso = (m) => new Date(now - m * 60000).toISOString();
  // s1: 2つの区間(180〜160分前、60〜50分前)/ s2: 30秒だけ(1分未満なので除く)/ s3: 作業中(除く)
  const s1 = [user('s1', iso(180), 'ghp_abcdefghijklmnopqrstuvwxyz0123 を使う修正'), asst('s1', iso(170)), asst('s1', iso(160)), user('s1', iso(60), '続き'), asst('s1', iso(50))];
  await writeFile(path.join(proj, 's1.jsonl'), s1.join('\n'));
  await writeFile(path.join(proj, 's2.jsonl'), [user('s2', iso(300), '短い作業'), asst('s2', iso(299.5))].join('\n'));
  await writeFile(path.join(proj, 's3.jsonl'), [user('s3', iso(20), '作業中のもの'), asst('s3', iso(1))].join('\n'));
  const api = fakeApi();
  const store = new Store({ projectsDir: path.join(root, 'projects'), cacheDir: path.join(root, 'cache'), syncs: clients(api.fetchImpl) });
  await store.scan();
  const range = { from: iso(24 * 60), to: new Date(now + 3600000).toISOString() };
  return { root, proj, store, api, range, s1, iso };
}

const titleOf = { gcal: (b) => b.summary, toggl: (b) => b.description, clockify: (b) => b.description, harvest: (b) => b.notes };

for (const { name } of SYNCS) {
  test(`${name}: 重複させずに記録し、変わったら更新、消えた区間は削除する`, async (t) => {
    const { proj, store, api, range, s1 } = await setup(t);
    const plan = await store.sync(name, range);
    assert.deepEqual(plan.create.map((x) => x.key), ['s1-0', 's1-1']); // 短いもの・作業中のものは除く
    assert.equal(plan.update.length + plan.delete.length, 0);
    assert.match(plan.previewText, /^追加 2件・更新 0件・削除 0件/);
    assert.match(plan.previewText, /\[web\] \[GITHUB_TOKEN\] を使う修正/);
    const r = await store.postSync({ target: name, ...range }, plan.hash);
    assert.deepEqual(r, { target: name, created: 2, updated: 0, deleted: 0 });
    const writes = api.calls.filter((c) => c.method !== 'GET' && c.path !== '/token');
    assert.equal(writes.length, 2);
    for (const c of api.calls) assert.equal(c.redirect, 'error');
    for (const c of writes) {
      assert.doesNotMatch(JSON.stringify(c.body), /ghp_/); // 秘匿情報は伏せる
      assert.equal(titleOf[name](c.body), '[GITHUB_TOKEN] を使う修正');
    }
    // 同じ hash ではもう送れない(二重送信の防止)
    await assert.rejects(store.postSync({ target: name, ...range }, plan.hash), (err) => err.status === 409);

    // 2回目は何も作らない
    const again = await store.sync(name, range);
    assert.deepEqual([again.create.length, again.update.length, again.delete.length, again.unchanged], [0, 0, 0, 2]);
    const map = JSON.parse(await readFile(path.join(store.cacheDir, `sync-${name}.json`), 'utf8'));
    assert.deepEqual(Object.keys(map.entries).sort(), ['s1-0', 's1-1']);

    // タイトルが変わったら更新
    const raw = store.getRaw('s1');
    store.summaries.s1 = { fingerprint: fingerprint(raw), title: '新しいタイトル', summary: '', source: 'llm' };
    const upd = await store.sync(name, range);
    assert.deepEqual(upd.update.map((x) => x.key), ['s1-0', 's1-1']);
    const before = api.calls.length;
    assert.deepEqual(await store.postSync({ target: name, ...range }, upd.hash), { target: name, created: 0, updated: 2, deleted: 0 });
    const updCalls = api.calls.slice(before).filter((c) => c.path !== '/token');
    assert.deepEqual(updCalls.map((c) => c.method), name === 'harvest' ? ['PATCH', 'PATCH'] : ['PUT', 'PUT']);
    assert.equal(titleOf[name](updCalls[0].body), '新しいタイトル');
    assert.equal(api.items.size, 2);

    // 2つめの区間が無くなったら(ログが書き換わったら)削除する
    await writeFile(path.join(proj, 's1.jsonl'), s1.slice(0, 3).join('\n'));
    await store.scan();
    const del = await store.sync(name, range);
    assert.deepEqual(del.delete.map((x) => x.key), ['s1-1']);
    assert.match(del.previewText, /削除:\n/);
    assert.deepEqual(await store.postSync({ target: name, ...range }, del.hash), { target: name, created: 0, updated: 0, deleted: 1 });
    assert.equal(api.calls.at(-1).method, 'DELETE');
    assert.equal(api.items.size, 1);
    assert.equal((await store.sync(name, range)).delete.length, 0);
  });
}

test('Google カレンダー: リフレッシュトークンでアクセストークンを取り、期限まで使い回す', async (t) => {
  const { store, api, range } = await setup(t);
  const plan = await store.sync('gcal', range);
  await store.postSync({ target: 'gcal', ...range }, plan.hash);
  const tokenCalls = api.calls.filter((c) => c.path === '/token');
  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0].method, 'POST');
  assert.equal(tokenCalls[0].headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(tokenCalls[0].body, { client_id: 'cid.apps.example', client_secret: 'GSECRET-xyz', refresh_token: 'GREFRESH-xyz', grant_type: 'refresh_token' });
  const ev = api.calls.filter((c) => c.path.startsWith('/gcal'));
  assert.deepEqual(ev.map((c) => `${c.method} ${c.path}`), ['POST /gcal/calendars/worklog-cal/events', 'POST /gcal/calendars/worklog-cal/events']);
  assert.equal(ev[0].headers.authorization, 'Bearer AT1');
  const b = ev[0].body;
  assert.deepEqual(b.extendedProperties, { private: { workLogKey: 's1-0' } });
  assert.match(b.start.dateTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(b.description, /^プロジェクト: web\nツール: Claude Code/);
  assert.equal(b.colorId, undefined);
  // 色は config.json の gcal.colorId で付ける
  const g = new GoogleCalendar({ env: ENV, fetchImpl: api.fetchImpl });
  g.setConfig({ colorId: 5 });
  assert.equal(g.payload({ key: 'k', title: 't', description: '', start: '2026-10-01T00:00:00Z', end: '2026-10-01T00:00:00Z' }).colorId, '5');
  assert.equal(g.payload({ key: 'k', title: 't', description: '', start: '2026-10-01T00:00:00Z', end: '2026-10-01T00:00:00Z' }).end.dateTime, '2026-10-01T00:01:00.000Z');
  // カレンダーの ID が無ければ設定なし
  assert.equal(new GoogleCalendar({ env: { ...ENV, GOOGLE_CALENDAR_ID: '' } }).status().configured, false);
  assert.match(new GoogleCalendar({ env: {} }).status().missing.join(' '), /GOOGLE_REFRESH_TOKEN/);
  // 認証に失敗したら伝える
  const bad = fakeApi();
  bad.failNext(400);
  const g2 = new GoogleCalendar({ env: ENV, fetchImpl: bad.fetchImpl });
  await assert.rejects(g2.create({ key: 'k', title: 't', description: '', start: '2026-10-01T00:00:00Z', end: '2026-10-01T00:10:00Z' }), /リフレッシュトークン/);
});

test('Toggl Track: Basic 認証、既定のワークスペース、プロジェクトとタグ', async (t) => {
  const { store, api, range } = await setup(t, { config: { toggl: { projects: { web: 555 } } } });
  const plan = await store.sync('toggl', range);
  await store.postSync({ target: 'toggl', ...range }, plan.hash);
  const [me, post] = api.calls;
  assert.equal(`${me.method} ${me.path}`, 'GET /toggl/me');
  assert.equal(me.headers.authorization, `Basic ${Buffer.from('TOGGLTOKEN123:api_token').toString('base64')}`);
  assert.equal(`${post.method} ${post.path}`, 'POST /toggl/workspaces/777/time_entries');
  assert.equal(api.calls.filter((c) => c.path === '/toggl/me').length, 1); // 既定のワークスペースは1回だけ聞く
  const b = post.body;
  assert.equal(b.created_with, 'work-log');
  assert.equal(b.workspace_id, 777);
  assert.equal(b.project_id, 555);
  assert.deepEqual(b.tags, ['work-log', 'web']);
  assert.match(b.start, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(b.duration, (Date.parse(b.stop) - Date.parse(b.start)) / 1000);
  assert.equal(b.duration, 20 * 60);
  // ワークスペースを指定したら問い合わせない
  const tg = new Toggl({ env: ENV, fetchImpl: api.fetchImpl, minIntervalMs: 0 });
  tg.setConfig({ workspaceId: 9 });
  assert.equal(await tg.workspaceId(), 9);
  assert.equal(tg.status().destination, 'ワークスペース 9');
});

test('Clockify: X-Api-Key と使用中のワークスペース', async (t) => {
  const { store, api, range } = await setup(t, { config: { clockify: { projects: { web: 'p-web' }, tagIds: ['t1'] } } });
  const plan = await store.sync('clockify', range);
  await store.postSync({ target: 'clockify', ...range }, plan.hash);
  const [me, post] = api.calls;
  assert.equal(`${me.method} ${me.path}`, 'GET /clockify/user');
  assert.equal(me.headers['x-api-key'], 'CLOCKIFYKEY123');
  assert.equal(`${post.method} ${post.path}`, 'POST /clockify/workspaces/ws-active/time-entries');
  assert.deepEqual(Object.keys(post.body), ['start', 'end', 'description', 'projectId', 'tagIds']);
  assert.equal(post.body.projectId, 'p-web');
  // 地域ごとの API は clockify.me の https だけ
  const c = new Clockify({ env: {}, fetchImpl: api.fetchImpl });
  c.setConfig({ baseUrl: 'https://euc1.clockify.me/api/v1' });
  assert.equal(c.base, 'https://euc1.clockify.me/api/v1');
  c.setConfig({ baseUrl: 'https://evil.example/api' });
  assert.equal(c.base, 'https://api.clockify.me/api/v1');
});

test('Harvest: 必須のヘッダー、時間(0.01 時間単位)と日付、プロジェクトの割り当て', async (t) => {
  const { store, api, range } = await setup(t, { config: { harvest: { projects: { web: { projectId: 1, taskId: 2 } }, timeZone: 'UTC' } } });
  const plan = await store.sync('harvest', range);
  await store.postSync({ target: 'harvest', ...range }, plan.hash);
  const post = api.calls[0];
  assert.equal(`${post.method} ${post.path}`, 'POST /harvest/time_entries');
  assert.equal(post.headers.authorization, 'Bearer HARVESTTOKEN123');
  assert.equal(post.headers['harvest-account-id'], '4242');
  assert.equal(post.headers['user-agent'], 'Work Log (local)');
  assert.deepEqual(Object.keys(post.body), ['project_id', 'task_id', 'spent_date', 'hours', 'notes']);
  assert.equal(post.body.project_id, 1);
  assert.equal(post.body.hours, 0.33); // 20分
  assert.match(post.body.spent_date, /^\d{4}-\d{2}-\d{2}$/);
  // 割り当ての無いプロジェクトは記録しない / プロジェクトとタスクが無ければ設定なし
  const h = new Harvest({ env: ENV });
  h.setConfig({ projects: { other: { projectId: 1, taskId: 2 } } });
  assert.equal(h.payload({ project: 'web', ms: 60000, title: 't', localDate: '2026-10-01' }), null);
  h.setConfig({});
  assert.equal(h.status().configured, false);
  assert.match(h.status().missing.join(' '), /harvest\.projectId/);
});

test('まとめる設定・最短の長さ・制限(429)・相手側で消された記録', async (t) => {
  const { store, api, range } = await setup(t, { config: { toggl: { mergeSegments: true, minMinutes: 0 } } });
  const plan = await store.sync('toggl', range);
  assert.deepEqual(plan.create.map((x) => x.key), ['s2', 's1']); // 0分以上なので短いものも含める。作業中のものは除く
  assert.equal(plan.status.mergeSegments, true);
  // 1件目の後に制限されたら、そこまでを記録して止まる
  api.calls.length = 0;
  const orig = api.fetchImpl;
  let posts = 0;
  store.syncs.clients.toggl.fetch = async (url, o) => {
    if (o.method === 'POST' && ++posts === 2) api.failNext(429, { 'retry-after': '30' });
    return orig(url, o);
  };
  await assert.rejects(store.postSync({ target: 'toggl', ...range }, plan.hash), (err) => err.status === 429 && /30秒後/.test(err.message) && /追加 1件/.test(err.message));
  const rest = await store.sync('toggl', range);
  assert.deepEqual([rest.create.length, rest.unchanged], [1, 1]); // 続きから
  await store.postSync({ target: 'toggl', ...range }, rest.hash);
  // 相手側で消された記録の更新は作り直す
  api.items.clear();
  const raw = store.getRaw('s1');
  store.summaries.s1 = { fingerprint: fingerprint(raw), title: '別のタイトル', summary: '', source: 'llm' };
  const upd = await store.sync('toggl', range);
  assert.equal(upd.update.length, 1);
  assert.deepEqual(await store.postSync({ target: 'toggl', ...range }, upd.hash), { target: 'toggl', created: 1, updated: 0, deleted: 0 });
});

test('不明な記録先・設定の無い記録先・長すぎる期間は断る', async (t) => {
  const { store, range } = await setup(t);
  await assert.rejects(store.sync('__proto__', range), /不明な記録先/);
  await assert.rejects(store.sync('slack', range), /不明な記録先/);
  store.syncs.clients.toggl = new Toggl({ env: {} });
  await assert.rejects(store.sync('toggl', range), /TOGGL_API_TOKEN/);
  await assert.rejects(store.sync('gcal', { from: '2025-01-01', to: '2026-01-01' }), /長すぎ/);
});

test('API: 下見と記録、/api/config に秘密は含めない', async (t) => {
  const { store, api, range } = await setup(t);
  const server = createServer(store, { env: {} });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cfgText = await (await fetch(`${base}/api/config`)).text();
  for (const v of Object.values(SECRETS).filter((v) => v !== 'worklog-cal' && v !== '4242')) assert.equal(cfgText.includes(v), false, v);
  const cfg = JSON.parse(cfgText);
  assert.deepEqual(cfg.syncs.map((s) => [s.name, s.configured]), [['gcal', true], ['toggl', true], ['clockify', true], ['harvest', true]]);
  assert.equal(cfg.syncs[1].label, 'Toggl Track');
  assert.equal(cfg.syncs[1].minMinutes, 1);

  const q = new URLSearchParams({ target: 'toggl', ...range });
  const pv = await (await fetch(`${base}/api/sync?${q}`)).json();
  assert.deepEqual(pv.counts, { create: 2, update: 0, delete: 0, unchanged: 0, skipped: 0 });
  assert.equal(pv.create[0].entry, undefined); // 送る本文そのものは返さない
  assert.match(pv.previewText, /\[GITHUB_TOKEN\]/);
  assert.doesNotMatch(JSON.stringify(pv), /ghp_/);
  const post = (body, headers = {}) => fetch(`${base}/api/sync`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ target: 'toggl', ...range, hash: 'wrong' })).status, 409);
  assert.equal((await post({ target: 'toggl', ...range, hash: pv.hash }, { origin: 'http://evil.example' })).status, 403);
  const ok = await post({ target: 'toggl', ...range, hash: pv.hash });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { target: 'toggl', created: 2, updated: 0, deleted: 0 });
  assert.equal(api.items.size, 2);
  const unknown = await fetch(`${base}/api/sync?target=nope`);
  assert.equal(unknown.status, 400);
});

test('セッションごと消えたものは最近のものだけ削除する(古いログの自動削除では消さない)', async (t) => {
  const { proj, store, range, iso } = await setup(t);
  const plan = await store.sync('clockify', range);
  await store.postSync({ target: 'clockify', ...range }, plan.hash);
  const file = path.join(store.cacheDir, 'sync-clockify.json');
  const map = JSON.parse(await readFile(file, 'utf8'));
  // 古い記録(30日前)を足しておく。対象の期間に入るよう、期間も広げる
  map.entries['gone-0'] = { id: 'x', hash: 'h', sessionId: 'gone', start: iso(30 * 1440), end: iso(30 * 1440 - 10), title: '古い', project: 'web' };
  await writeFile(file, JSON.stringify(map));
  await rm(path.join(proj, 's1.jsonl'));
  await store.scan();
  const del = await store.sync('clockify', { from: iso(40 * 1440), to: range.to });
  assert.deepEqual(del.delete.map((x) => x.key).sort(), ['s1-0', 's1-1']);
});
