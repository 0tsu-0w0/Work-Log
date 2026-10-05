// Redmine と Gitea / Forgejo の課題の取得・振り分け・コメント、Redmine の作業時間と Jira の作業ログへの記録(偽のサーバー)。
// 応答の形は Docker の本物のサーバー(Redmine 6.1.5 / Gitea 28.0.0)で確かめたものに合わせている。Jira は本物では未確認。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RedmineIssues, redmineCategory } from '../src/trackers/redmine.js';
import { GiteaIssues } from '../src/trackers/gitea.js';
import { Trackers } from '../src/trackers/index.js';
import { refsFromText, resolveRef, normalizeConfig } from '../src/tasks.js';
import { buildWorkLog } from '../src/worklog.js';
import { GitHubIssues } from '../src/github.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { RedmineTime } from '../src/sync/redmine.js';
import { JiraWorklog, jiraTime } from '../src/sync/jira.js';

const cfg = normalizeConfig();

function fake(routes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    const r = routes(url, opts);
    return new Response(r.body === undefined ? null : typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status || 200, headers: r.headers || {} });
  };
  return { calls, fetchImpl };
}

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'work-log-rg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Redmine 6.1.5 の GET /issues/{id}.json の応答(本物から取ったもの。不要な項目は省いた)
const redmineIssue = (id, subject, status) => ({
  issue: { id, project: { id: 1, name: 'WLB Project' }, tracker: { id: 1, name: 'Bug' }, status, priority: { id: 2, name: 'Normal' }, assigned_to: { id: 1, name: 'Redmine Admin' }, subject, updated_on: '2026-10-05T08:31:31Z' },
});

test('Redmine: API キーはヘッダーで送り、状態を分類し、注記を投稿して #change-<id> を返す', async (t) => {
  const dir = await tmp(t);
  const f = fake((url, o) => {
    if (o.method === 'PUT') return { status: 204 };
    if (url.includes('include=journals')) return { body: { issue: { id: 1, journals: [{ id: 3, notes: '前のもの' }, { id: 4, notes: '本文' }] } } };
    if (url.endsWith('/issues/1.json')) return { body: redmineIssue(1, 'ログイン', { id: 2, name: 'In Progress', is_closed: false }) };
    if (url.endsWith('/issues/2.json')) return { body: redmineIssue(2, 'CSV', { id: 5, name: 'Closed', is_closed: true }) };
    return { status: 404, body: '' };
  });
  const rm_ = new RedmineIssues({ cacheDir: dir, env: { REDMINE_URL: 'https://redmine.example.com/', REDMINE_API_KEY: 'rk' }, fetchImpl: f.fetchImpl });
  const e = await rm_.getRef({ number: 1 });
  assert.equal(f.calls[0].url, 'https://redmine.example.com/issues/1.json');
  assert.equal(f.calls[0].headers['x-redmine-api-key'], 'rk');
  assert.deepEqual([e.data.title, e.data.stateLabel, e.data.stateCategory, e.data.kindLabel, e.data.assignees, e.data.priority, e.data.url], ['ログイン', 'In Progress', 'in_progress', 'Bug', ['Redmine Admin'], 'Normal', 'https://redmine.example.com/issues/1']);
  assert.equal((await rm_.getRef({ number: 2 })).data.stateCategory, 'done');
  assert.equal((await rm_.getRef({ number: 9 })).error, 'not_found');
  assert.equal(rm_.valid({ number: 0 }), false);
  // 状態の分類: 終わった状態のうち却下は見送り。is_closed の無い古い版は名前で推測する
  assert.equal(redmineCategory({ id: 6, name: 'Rejected', is_closed: true }), 'canceled');
  assert.equal(redmineCategory({ id: 1, name: 'New', is_closed: false }), 'open');
  assert.equal(redmineCategory({ id: 3, name: 'Resolved', is_closed: false }), 'in_progress');
  assert.equal(redmineCategory({ id: 9, name: '終了' }), 'done');
  const posted = await rm_.comment({ number: 1 }, '本文');
  const put = f.calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, 'https://redmine.example.com/issues/1.json');
  assert.deepEqual(JSON.parse(put.body), { issue: { notes: '本文' } });
  assert.equal(posted.url, 'https://redmine.example.com/issues/1#change-4');
  await assert.rejects(new RedmineIssues({ cacheDir: dir, env: { REDMINE_URL: 'https://r.example' } }).comment({ number: 1 }, 'x'), /REDMINE_API_KEY/);
  // 書式は設定で Textile にできる(既定は Markdown = Redmine 6 の既定の CommonMark)
  assert.equal(rm_.commentFormat(), 'markdown');
  assert.equal(new RedmineIssues({ cacheDir: dir, env: {}, format: 'textile' }).commentFormat(), 'textile');
  // http(s) 以外の接続先は受け付けない
  assert.equal(new RedmineIssues({ cacheDir: dir, env: { REDMINE_URL: 'javascript:alert(1)' } }).configured(), false);
});

test('Gitea: token ヘッダー、issue とマージ済みの PR、コメントの html_url', async (t) => {
  const dir = await tmp(t);
  const f = fake((url, o) => {
    if (o.method === 'POST') return { status: 201, body: { id: 9, html_url: 'https://git.example.com/acme/shop/issues/1#issuecomment-9', body: JSON.parse(o.body).body } };
    if (url.endsWith('/issues/1')) {
      return { body: { number: 1, title: '在庫数が負になる', state: 'open', labels: [{ name: 'bug', color: 'ee0701' }], assignees: [{ login: 'wladmin' }], html_url: 'https://git.example.com/acme/shop/issues/1', pull_request: null, updated_at: '2026-10-05T08:31:48Z' } };
    }
    if (url.endsWith('/issues/2')) return { body: { number: 2, title: '在庫の修正', state: 'closed', labels: [], assignees: null, html_url: 'https://git.example.com/acme/shop/pulls/2', pull_request: { merged: true, draft: false } } };
    return { status: 404, body: { message: 'not found' } };
  });
  const g = new GiteaIssues({ cacheDir: dir, env: { GITEA_URL: 'https://git.example.com', GITEA_TOKEN: 'gt' }, fetchImpl: f.fetchImpl });
  const i = await g.getRef({ repo: 'acme/shop', number: 1 });
  assert.equal(f.calls[0].url, 'https://git.example.com/api/v1/repos/acme/shop/issues/1');
  assert.equal(f.calls[0].headers.authorization, 'token gt');
  assert.deepEqual([i.data.title, i.data.stateCategory, i.data.kindLabel, i.data.labels, i.data.assignees], ['在庫数が負になる', 'open', 'Issue', [{ name: 'bug', color: 'ee0701' }], ['wladmin']]);
  const pr = await g.getRef({ repo: 'acme/shop', number: 2 });
  assert.deepEqual([pr.data.kindLabel, pr.data.stateLabel, pr.data.stateCategory, pr.data.isPR, pr.data.assignees], ['PR', 'Merged', 'done', true, []]);
  assert.equal((await g.getRef({ repo: 'acme/shop', number: 3 })).error, 'not_found');
  assert.equal(g.valid({ repo: 'acme/../x', number: 1 }), false);
  const posted = await g.comment({ repo: 'acme/shop', number: 1 }, 'メモ');
  const post = f.calls.find((c) => c.method === 'POST');
  assert.equal(post.url, 'https://git.example.com/api/v1/repos/acme/shop/issues/1/comments');
  assert.deepEqual(JSON.parse(post.body), { body: 'メモ' });
  assert.equal(posted.url, 'https://git.example.com/acme/shop/issues/1#issuecomment-9');
  await assert.rejects(new GiteaIssues({ cacheDir: dir, env: { GITEA_URL: 'https://g.example' } }).comment({ repo: 'a/b', number: 1 }, 'x'), /GITEA_TOKEN/);
  // Forgejo の環境変数でもよい
  const fj = new GiteaIssues({ cacheDir: dir, env: { FORGEJO_URL: 'https://codeberg.example', FORGEJO_TOKEN: 'ft' } });
  assert.deepEqual([fj.host(), fj.headers().authorization], ['codeberg.example', 'token ft']);
});

test('振り分け: Redmine と Gitea の URL、"#123" と "owner/repo#12" は設定とリポジトリのホストで決める', async (t) => {
  const dir = await tmp(t);
  const env = { REDMINE_URL: 'https://pm.example.com/redmine', GITEA_URL: 'https://git.example.com' };
  const trk = new Trackers({ cacheDir: dir, env, config: { redmine: { projects: ['ops'], keys: ['RM'] }, gitea: { repos: ['acme/shop'] }, linear: {} } });
  const text = 'https://pm.example.com/redmine/issues/42 と https://git.example.com/acme/shop/issues/7 と https://git.example.com/acme/shop/pulls/8 と https://other.example.com/x/y/issues/1 と https://github.com/a/b/issues/3';
  const refs = [...refsFromText(text, 'prompt', cfg).values()];
  const resolved = refs.map((r) => resolveRef(r, { cfg, trackers: trk })).filter(Boolean);
  assert.deepEqual(resolved.map((r) => [r.provider, r.id, r.label, r.url]), [
    ['redmine', 'redmine#42', 'Redmine #42', 'https://pm.example.com/redmine/issues/42'],
    ['gitea', 'acme/shop#7', 'shop#7', 'https://git.example.com/acme/shop/issues/7'],
    ['gitea', 'acme/shop#8', 'shop#8', 'https://git.example.com/acme/shop/pulls/8'],
    ['github', 'a/b#3', 'b#3', 'https://github.com/a/b/issues/3'], // 設定に無いホストの URL は捨てる。GitHub は二重に拾わない
  ]);
  const r = (ref, extra = {}) => resolveRef(ref, { cfg, trackers: trk, ...extra });
  const hash = { id: '#12', kind: 'github', number: 12 };
  // 設定したプロジェクトの "#12" は、リポジトリが GitHub でも Redmine
  assert.deepEqual([r(hash, { project: 'ops', repoInfo: { host: 'github.com', path: 'a/b' } }).provider, r(hash, { project: 'ops' }).id], ['redmine', 'redmine#12']);
  // それ以外は、リポジトリのホストで決まる。リポジトリが無ければ Redmine
  assert.equal(r(hash, { project: 'web', repoInfo: { host: 'github.com', path: 'a/b' } }).provider, 'github');
  const gt = r(hash, { project: 'web', repoInfo: { host: 'git.example.com', path: 'acme/api' } });
  assert.deepEqual([gt.provider, gt.id, gt.url], ['gitea', 'acme/api#12', 'https://git.example.com/acme/api/issues/12']);
  assert.equal(r({ id: '!3', kind: 'github', number: 3, mr: true }, { repoInfo: { host: 'git.example.com', path: 'acme/api' } }), null);
  assert.equal(r(hash, { project: 'web' }).provider, 'redmine');
  // "owner/repo#12" は tasks.gitea.repos にあるものだけ Gitea(無ければ GitHub のまま)
  assert.equal(r({ id: 'acme/shop#5', kind: 'github', repo: 'acme/shop', number: 5 }).provider, 'gitea');
  assert.equal(r({ id: 'acme/other#5', kind: 'github', repo: 'acme/other', number: 5 }).provider, 'github');
  // キー形式は設定したプレフィックスだけ Redmine
  const rm5 = r({ id: 'RM-5', kind: 'key' });
  assert.deepEqual([rm5.provider, rm5.id, rm5.label, rm5.number, rm5.url], ['redmine', 'redmine#5', 'RM-5', 5, 'https://pm.example.com/redmine/issues/5']);
  // Redmine しか設定していなくても、プレフィックスの無いキーを Redmine にはしない
  const only = new Trackers({ cacheDir: dir, env: { REDMINE_URL: 'https://pm.example.com' } });
  assert.equal(resolveRef({ id: 'ENG-1', kind: 'key' }, { cfg, trackers: only }).provider, null);
  // Redmine を設定していなければ、リポジトリの無い "#12" は今までどおり決めない
  const none = new Trackers({ cacheDir: dir, env: {} });
  assert.equal(resolveRef(hash, { cfg, trackers: none }).provider, undefined);
  assert.equal(resolveRef({ id: 'u', kind: 'url', url: 'https://pm.example.com/issues/1' }, { cfg, trackers: none }), null);
});

test('作業記録の Textile: 表のセルは <notextile> で囲み、| は全角にする', () => {
  const t = { activeMs: 600000, commits: 0, first: '2026-10-01T01:00:00Z', last: '2026-10-01T01:10:00Z', sessions: [{ start: '2026-10-01T01:00:00Z', title: 'A | *B* </notextile> -c-', tool: 'claude', activeMs: 600000, commits: 0 }] };
  const s = buildWorkLog(t, { format: 'textile', timeZone: 'UTC' });
  assert.match(s, /^h3\. 作業記録/);
  assert.match(s, /\|_\. 開始 \|_\. セッション \|/);
  assert.ok(s.includes('| <notextile>A ｜ *B*  -c-</notextile> | Claude Code | 10分 |'), s);
});

// Claude Code のログ(2つのセッション)と config.json を置いたストア
async function storeWith(t, { config, prompts, env = {} }) {
  const root = await tmp(t);
  const cacheDir = path.join(root, 'cache');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, 'config.json'), JSON.stringify(config));
  const now = Date.now();
  const iso = (m) => new Date(now - m * 60000).toISOString();
  for (const [i, prompt] of prompts.entries()) {
    const proj = path.join(root, 'projects', `-p${i}`);
    await mkdir(proj, { recursive: true });
    const line = (o) => JSON.stringify({ sessionId: `s${i}`, cwd: `/nonexistent/p${i}`, ...o });
    const start = 300 - i * 100;
    await writeFile(path.join(proj, `s${i}.jsonl`), [
      line({ type: 'user', timestamp: iso(start), message: { role: 'user', content: prompt } }),
      line({ type: 'assistant', timestamp: iso(start - 30), message: { id: `a${i}`, model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [] } }),
    ].join('\n'));
  }
  const store = new Store({ projectsDir: path.join(root, 'projects'), cacheDir, github: new GitHubIssues({ cacheDir, env: {}, tokenProvider: async () => null }) });
  store.trackers.env = env;
  return { root, store, iso, now };
}

test('ストア経由: URL と "#番号" を1つの課題にまとめ、Redmine(Textile)と Gitea にコメントする', async (t) => {
  const f = fake((url, o) => {
    if (url.startsWith('https://rm.example.com')) {
      if (o.method === 'PUT') return { status: 204 };
      if (url.includes('include=journals')) return { body: { issue: { journals: [{ id: 11, notes: JSON.parse(f.calls.find((c) => c.method === 'PUT').body).issue.notes }] } } };
      return { body: redmineIssue(42, 'バリデーション', { id: 1, name: 'New', is_closed: false }) };
    }
    if (o.method === 'POST') return { status: 201, body: { id: 5, html_url: 'https://git.example.com/acme/shop/issues/7#issuecomment-5' } };
    return { body: { number: 7, title: '在庫', state: 'closed', labels: [], assignees: [], html_url: 'https://git.example.com/acme/shop/issues/7', pull_request: null } };
  });
  const env = { REDMINE_URL: 'https://rm.example.com', REDMINE_API_KEY: 'RMKEY-secret', GITEA_URL: 'https://git.example.com', GITEA_TOKEN: 'GTTOKEN-secret' };
  const { store } = await storeWith(t, {
    config: { tasks: { redmine: { format: 'textile' }, gitea: { repos: ['acme/shop'] } } },
    prompts: ['https://rm.example.com/issues/42 を直す。#42 の続き', 'acme/shop#7 と https://git.example.com/acme/shop/issues/7 を見る'],
    env,
  });
  store.trackers.fetchImpl = f.fetchImpl;
  await store.scan();
  const tasks = await store.tasks({});
  assert.deepEqual(tasks.map((x) => [x.id, x.provider, x.sessions.length, x.issue?.title]).sort(), [
    ['acme/shop#7', 'gitea', 1, '在庫'],
    ['redmine#42', 'redmine', 1, 'バリデーション'],
  ]);
  const rc = await store.issueComment('redmine#42', { timeZone: 'UTC' });
  assert.deepEqual([rc.provider, rc.providerLabel, rc.target], ['redmine', 'Redmine', 'Redmine #42']);
  assert.match(rc.body, /^h3\. 作業記録/);
  const gc = await store.issueComment('acme/shop#7', { timeZone: 'UTC' });
  assert.match(gc.body, /^### 作業記録/);

  const server = createServer(store, { env: {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (id, hash) => fetch(`${base}/api/tasks/comment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, hash, tz: 'UTC' }) });
  const pv = await (await fetch(`${base}/api/tasks/comment?id=${encodeURIComponent('redmine#42')}&tz=UTC`)).json();
  assert.equal((await post('redmine#42', 'wrong')).status, 409);
  assert.deepEqual(await (await post('redmine#42', pv.hash)).json(), { url: 'https://rm.example.com/issues/42#change-11' });
  assert.deepEqual(await (await post('acme/shop#7', gc.hash)).json(), { url: 'https://git.example.com/acme/shop/issues/7#issuecomment-5' });
  const cfgText = await (await fetch(`${base}/api/config`)).text();
  assert.doesNotMatch(cfgText, /RMKEY-secret|GTTOKEN-secret/);
  assert.deepEqual(JSON.parse(cfgText).trackers.filter((x) => ['redmine', 'gitea'].includes(x.name)).map((x) => [x.name, x.configured, x.authenticated]), [['redmine', true, true], ['gitea', true, true]]);
});

// ---------------------------------------------------------------- 記録先(Redmine の作業時間・Jira の作業ログ)
function timeApi() {
  const calls = [];
  const items = new Map();
  let n = 100;
  let activities = [{ id: 8, name: 'Design', is_default: false, active: true }, { id: 9, name: 'Development', is_default: true, active: true }];
  const json = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, o = {}) => {
    const u = new URL(url);
    const method = o.method || 'GET';
    const body = o.body ? JSON.parse(o.body) : undefined;
    calls.push({ path: u.pathname, method, headers: o.headers, body });
    if (u.pathname.endsWith('/enumerations/time_entry_activities.json')) return json(200, { time_entry_activities: activities });
    // 本物の Redmine 6.1 は project_id に識別子を渡すと 422 "Project is invalid" になる。識別子は ID に直してから送る
    if (u.pathname === '/projects/web-proj.json') return json(200, { project: { id: 77, identifier: 'web-proj' } });
    if (u.pathname.startsWith('/projects/')) return json(404, null);
    if (method === 'POST' && body?.time_entry && typeof body.time_entry.project_id === 'string') return json(422, { errors: ['Project is invalid'] });
    if (method === 'POST' && u.pathname.endsWith('/time_entries.json')) {
      if (!body.time_entry.activity_id) return json(422, { errors: ['Activity cannot be blank'] });
      items.set(String(++n), body.time_entry);
      return json(201, { time_entry: { id: n } });
    }
    if (method === 'POST' && u.pathname.endsWith('/worklog')) {
      items.set(String(++n), { key: u.pathname.split('/').at(-2), ...body });
      return json(201, { id: String(n) });
    }
    const id = u.pathname.replace(/\.json$/, '').split('/').pop();
    if (!items.has(id)) return json(404, { errorMessages: ['Worklog not found'] });
    if (method === 'DELETE') {
      items.delete(id);
      return new Response(null, { status: 204 });
    }
    items.set(id, body.time_entry || { key: u.pathname.split('/').at(-3), ...body });
    return new Response(null, { status: 204 });
  };
  return { calls, items, fetchImpl, setActivities: (a) => (activities = a) };
}

test('Redmine の作業時間: 紐付いた課題、無ければプロジェクト、既定の作業分類、再実行で重複しない', async (t) => {
  const api = timeApi();
  const env = { REDMINE_URL: 'https://rm.example.com', REDMINE_API_KEY: 'RMKEY' };
  const { store } = await storeWith(t, {
    config: { redmine: { projects: { p1: 'web-proj' }, timeZone: 'UTC' }, tasks: { redmine: { projects: [] } } },
    prompts: ['https://rm.example.com/issues/42 を直す', '画面の調整', 'ほかの作業'],
    env,
  });
  store.syncs.clients.redmine = new RedmineTime({ env, fetchImpl: api.fetchImpl, minIntervalMs: 0 });
  await store.loadConfig();
  await store.scan();
  const range = { from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 3600000).toISOString() };
  const plan = await store.sync('redmine', range);
  assert.deepEqual([plan.create.map((x) => x.key), plan.skipped], [['s0-0', 's1-0'], 1]); // p2 は記録先が決まらない
  assert.match(plan.previewText, /記録先の決まらないもの 1件/);
  assert.deepEqual(await store.postSync({ target: 'redmine', ...range }, plan.hash), { target: 'redmine', created: 2, updated: 0, deleted: 0 });
  const posts = api.calls.filter((c) => c.method === 'POST');
  assert.equal(posts[0].path, '/time_entries.json');
  assert.equal(posts[0].headers['x-redmine-api-key'], 'RMKEY');
  const today = new Date(Date.now() - 300 * 60000).toISOString().slice(0, 10);
  assert.deepEqual(posts[0].body, { time_entry: { issue_id: 42, spent_on: today, hours: 0.5, comments: 'https://rm.example.com/issues/42 を直す', activity_id: 9 } });
  assert.equal(posts[1].body.time_entry.project_id, 77);
  assert.equal(api.calls.filter((c) => c.path === '/projects/web-proj.json').length, 1); // 識別子の ID は1回だけ聞く
  assert.equal(api.calls.filter((c) => c.path.endsWith('time_entry_activities.json')).length, 1); // 既定の作業分類は1回だけ聞く
  const again = await store.sync('redmine', range);
  assert.deepEqual([again.create.length, again.update.length, again.unchanged], [0, 0, 2]);
  // 作業分類を設定すると、それで更新する
  await writeFile(path.join(store.cacheDir, 'config.json'), JSON.stringify({ redmine: { projects: { p1: 'web-proj' }, timeZone: 'UTC', activityId: 8 } }));
  await store.loadConfig();
  const upd = await store.sync('redmine', range);
  assert.equal(upd.update.length, 2);
  await store.postSync({ target: 'redmine', ...range }, upd.hash);
  assert.deepEqual([...api.items.values()].map((x) => x.activity_id), [8, 8]);
});

test('Redmine の作業時間: 既定の作業分類が無ければ設定を求め、Redmine のエラーの理由を伝える', async () => {
  const api = timeApi();
  api.setActivities([{ id: 8, name: 'Design', is_default: false, active: true }, { id: 9, name: 'Development', is_default: false, active: true }]);
  const c = new RedmineTime({ env: { REDMINE_URL: 'https://rm.example.com', REDMINE_API_KEY: 'k' }, fetchImpl: api.fetchImpl, minIntervalMs: 0 });
  const e = { key: 'k', project: 'p', title: 'x'.repeat(300), ms: 61 * 60000, localDate: '2026-10-05', links: [{ provider: 'redmine', number: 3 }] };
  await assert.rejects(c.create(e), /redmine\.activityId.*8: Design、9: Development/);
  assert.equal([...c.payload(e).time_entry.comments].length, 255);
  assert.equal(c.payload(e).time_entry.hours, 1.02);
  // 422 の理由(errors の配列)をそのまま伝える
  const bad = new RedmineTime({ env: c.env, minIntervalMs: 0, fetchImpl: async () => new Response(JSON.stringify({ errors: ['Issue is invalid'] }), { status: 422 }) });
  bad.setConfig({ activityId: 9 });
  await assert.rejects(bad.create(e), /Redmine\(作業時間\) 422: Issue is invalid/);
  const nf = new RedmineTime({ env: c.env, fetchImpl: api.fetchImpl, minIntervalMs: 0 });
  nf.setConfig({ projectId: 'nope', activityId: 9 });
  await assert.rejects(nf.create({ ...e, links: [] }), /404/);
  assert.equal(new RedmineTime({ env: {} }).status().configured, false);
  assert.deepEqual(new RedmineTime({ env: {} }).missing(), ['REDMINE_URL', 'REDMINE_API_KEY']);
});

test('Jira の作業ログ: v3 の形(started・timeSpentSeconds・ADF)、課題が変わったら作り直す、Server は v2', async (t) => {
  const api = timeApi();
  const env = { JIRA_EMAIL: 'me@example.com', JIRA_API_TOKEN: 'JT' };
  const { store, root } = await storeWith(t, {
    config: { tasks: { jira: { baseUrl: 'https://acme.atlassian.net', keys: ['OPS'] } } },
    prompts: ['OPS-7 の請求を直す', 'Jira に紐付かない作業'],
    env,
  });
  store.syncs.clients.jira = new JiraWorklog({ env, fetchImpl: api.fetchImpl, minIntervalMs: 0 });
  await store.loadConfig();
  await store.scan();
  const range = { from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 3600000).toISOString() };
  const plan = await store.sync('jira', range);
  assert.deepEqual([plan.create.map((x) => x.key), plan.skipped], [['s0-0'], 1]);
  await store.postSync({ target: 'jira', ...range }, plan.hash);
  const post = api.calls.find((c) => c.method === 'POST');
  assert.equal(post.path, '/rest/api/3/issue/OPS-7/worklog');
  assert.equal(post.headers.authorization, `Basic ${Buffer.from('me@example.com:JT').toString('base64')}`);
  assert.match(post.body.started, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+0000$/);
  assert.equal(post.body.timeSpentSeconds, 1800);
  assert.deepEqual(post.body.comment, { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'OPS-7 の請求を直す' }] }] });
  const map = JSON.parse(await readFile(path.join(store.cacheDir, 'sync-jira.json'), 'utf8'));
  assert.equal(map.entries['s0-0'].id, 'OPS-7:101');
  assert.equal((await store.sync('jira', range)).unchanged, 1);
  // 紐付く課題を変える(手で付け替える)と、古い課題の作業ログを消して新しい課題に作る
  await store.updateLinks('s0', { remove: ['OPS-7'], add: ['OPS-8'] });
  const upd = await store.sync('jira', range);
  assert.equal(upd.update.length, 1);
  assert.deepEqual(await store.postSync({ target: 'jira', ...range }, upd.hash), { target: 'jira', created: 0, updated: 1, deleted: 0 });
  assert.deepEqual(api.calls.slice(-2).map((c) => `${c.method} ${c.path}`), ['DELETE /rest/api/3/issue/OPS-7/worklog/101', 'POST /rest/api/3/issue/OPS-8/worklog']);
  const map2 = JSON.parse(await readFile(path.join(store.cacheDir, 'sync-jira.json'), 'utf8'));
  assert.equal(map2.entries['s0-0'].id, 'OPS-8:102');
  assert.deepEqual([...api.items.values()].map((x) => x.key), ['OPS-8']);
  assert.ok(root);

  // Server / Data Center(PAT): v2 で、コメントは文字列
  const v2 = new JiraWorklog({ env: { JIRA_PAT: 'pat', JIRA_BASE_URL: 'https://jira.example.com' }, fetchImpl: api.fetchImpl, minIntervalMs: 0 });
  const e = { title: 't', start: '2026-10-04T01:02:03.456Z', ms: 20000, links: [{ provider: 'jira', id: 'OPS-1' }] };
  assert.deepEqual(v2.payload(e), { key: 'OPS-1', body: { started: '2026-10-04T01:02:03.456+0000', timeSpentSeconds: 60, comment: 't' } });
  assert.equal(await v2.create(e), 'OPS-1:103');
  assert.equal(api.calls.at(-1).path, '/rest/api/2/issue/OPS-1/worklog');
  assert.equal(api.calls.at(-1).headers.authorization, 'Bearer pat');
  assert.equal(v2.payload({ ...e, links: [{ provider: 'redmine', number: 1 }] }), null);
  assert.equal(jiraTime('2021-01-17T12:34:00Z'), '2021-01-17T12:34:00.000+0000');
  assert.match(new JiraWorklog({ env: {} }).missing().join(' '), /JIRA_BASE_URL/);
});
