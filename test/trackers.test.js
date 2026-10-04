import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { GitLabIssues, LinearIssues, JiraIssues, BacklogIssues } from '../src/trackers/providers.js';
import { Trackers } from '../src/trackers/index.js';
import { refsFromText, resolveRef, normalizeConfig, repoInfoOf } from '../src/tasks.js';
import { buildWorkLog } from '../src/worklog.js';
import { GitHubIssues } from '../src/github.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

const cfg = normalizeConfig();

// 各サービスの API の代わり。呼ばれた内容を記録し、routes の返す内容で応答する
function fake(routes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, ...opts });
    const r = routes(url, opts);
    return new Response(r.body === undefined ? null : typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status || 200, headers: r.headers || {} });
  };
  return { calls, fetchImpl };
}

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'work-log-trk-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('GitLab: issue と MR を取得し、ノートを投稿する', async (t) => {
  const dir = await tmp(t);
  const f = fake((url, o) => {
    if (o.method === 'POST') return { status: 201, body: { id: 77 } };
    if (url.includes('/merge_requests/5')) return { body: { title: 'feat: 在庫', state: 'opened', draft: true, labels: ['ui'], assignees: [{ username: 'me' }], web_url: 'https://gitlab.com/acme/shop/app/-/merge_requests/5' }, headers: { etag: 'W/"m5"' } };
    if (url.includes('/issues/3')) return { body: { title: '合計がずれる', state: 'closed', labels: ['bug'], assignees: [], web_url: 'https://gitlab.com/acme/shop/app/-/issues/3' } };
    return { status: 404, body: {} };
  });
  const gl = new GitLabIssues({ cacheDir: dir, env: { GITLAB_TOKEN: 'glpat' }, fetchImpl: f.fetchImpl });
  const mr = await gl.getRef({ repo: 'acme/shop/app', number: 5, mr: true });
  assert.equal(f.calls[0].url, 'https://gitlab.com/api/v4/projects/acme%2Fshop%2Fapp/merge_requests/5');
  assert.equal(f.calls[0].headers['private-token'], 'glpat');
  assert.deepEqual([mr.data.kindLabel, mr.data.stateLabel, mr.data.stateCategory, mr.data.labels, mr.data.assignees], ['MR', 'Draft', 'in_progress', [{ name: 'ui', color: null }], ['me']]);
  const issue = await gl.getRef({ repo: 'acme/shop/app', number: 3 });
  assert.deepEqual([issue.data.stateLabel, issue.data.stateCategory], ['Closed', 'done']);
  assert.equal((await gl.getRef({ repo: 'acme/shop/app', number: 9 })).error, 'not_found');
  assert.equal(gl.valid({ repo: 'acme/../x', number: 1 }), false);
  assert.equal(gl.valid({ repo: 'single', number: 1 }), false);
  const posted = await gl.comment({ repo: 'acme/shop/app', number: 3 }, '本文');
  const post = f.calls.find((c) => c.method === 'POST');
  assert.equal(post.url, 'https://gitlab.com/api/v4/projects/acme%2Fshop%2Fapp/issues/3/notes');
  assert.deepEqual(JSON.parse(post.body), { body: '本文' });
  assert.equal(posted.url, 'https://gitlab.com/acme/shop/app/-/issues/3#note_77');
  await assert.rejects(new GitLabIssues({ cacheDir: dir, env: {} }).comment({ repo: 'a/b', number: 1 }, 'x'), /GITLAB_TOKEN/);
});

test('Linear: GraphQL で取得し、コメントを作る', async (t) => {
  const dir = await tmp(t);
  const f = fake((url, o) => {
    const q = JSON.parse(o.body);
    if (q.query.includes('commentCreate')) return { body: { data: { commentCreate: { success: true, comment: { url: 'https://linear.app/acme/issue/ENG-12#comment-1' } } } } };
    if (q.variables.id === 'ENG-12') {
      return { body: { data: { issue: { identifier: 'ENG-12', title: 'ログインを直す', url: 'https://linear.app/acme/issue/ENG-12/login', updatedAt: '2026-10-01T00:00:00Z', priorityLabel: 'High', state: { name: 'In Review', type: 'started' }, labels: { nodes: [{ name: 'Bug', color: '#eb5757' }] }, assignee: { name: 'me', displayName: 'Me' } } } } };
    }
    return { body: { data: { issue: null }, errors: [{ message: 'Entity not found', extensions: { code: 'INVALID_INPUT' } }] } };
  });
  const ln = new LinearIssues({ cacheDir: dir, env: { LINEAR_API_KEY: 'lin_api_x' }, fetchImpl: f.fetchImpl });
  const e = await ln.getRef({ id: 'ENG-12' });
  assert.equal(f.calls[0].url, 'https://api.linear.app/graphql');
  assert.equal(f.calls[0].headers.authorization, 'lin_api_x'); // 個人 API キーは Bearer を付けない
  assert.deepEqual([e.data.title, e.data.stateLabel, e.data.stateCategory, e.data.labels, e.data.assignees, e.data.priority], ['ログインを直す', 'In Review', 'in_progress', [{ name: 'Bug', color: 'eb5757' }], ['Me'], 'High']);
  assert.equal((await ln.getRef({ id: 'ENG-99' })).error, 'not_found');
  const posted = await ln.comment({ id: 'ENG-12' }, 'メモ');
  const mutation = JSON.parse(f.calls.at(-1).body);
  assert.deepEqual(mutation.variables, { issueId: 'ENG-12', body: 'メモ' });
  assert.equal(posted.url, 'https://linear.app/acme/issue/ENG-12#comment-1');
  // キーが無ければ問い合わせない
  const anon = new LinearIssues({ cacheDir: dir, env: {}, fetchImpl: f.fetchImpl });
  const n = f.calls.length;
  assert.equal((await anon.getRef({ id: 'ENG-1' })).error, 'unauthorized');
  assert.equal(f.calls.length, n);
});

test('Jira: Cloud(Basic)と Server(PAT)で取得し、Wiki 記法のコメントを投稿する', async (t) => {
  const dir = await tmp(t);
  const f = fake((url, o) => {
    if (o.method === 'POST') return { status: 201, body: { id: '10042' } };
    return { body: { fields: { summary: '請求書のPDFが崩れる', status: { name: '進行中', statusCategory: { key: 'indeterminate' } }, labels: ['billing'], assignee: { displayName: '山田' }, issuetype: { name: 'バグ' }, updated: '2026-10-01T00:00:00.000+0900' } } };
  });
  const cloud = new JiraIssues({ cacheDir: dir, baseUrl: 'https://acme.atlassian.net/', env: { JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 'tok' }, fetchImpl: f.fetchImpl });
  const e = await cloud.getRef({ id: 'OPS-7' });
  assert.match(f.calls[0].url, /^https:\/\/acme\.atlassian\.net\/rest\/api\/2\/issue\/OPS-7\?fields=/);
  assert.equal(f.calls[0].headers.authorization, `Basic ${Buffer.from('a@b.c:tok').toString('base64')}`);
  assert.deepEqual([e.data.title, e.data.kindLabel, e.data.stateLabel, e.data.stateCategory, e.data.labels[0].name, e.data.assignees, e.data.url], ['請求書のPDFが崩れる', 'バグ', '進行中', 'in_progress', 'billing', ['山田'], 'https://acme.atlassian.net/browse/OPS-7']);
  const posted = await cloud.comment({ id: 'OPS-7' }, 'h3. 記録');
  assert.equal(f.calls.at(-1).url, 'https://acme.atlassian.net/rest/api/2/issue/OPS-7/comment');
  assert.deepEqual(JSON.parse(f.calls.at(-1).body), { body: 'h3. 記録' });
  assert.equal(posted.url, 'https://acme.atlassian.net/browse/OPS-7?focusedCommentId=10042');
  const server = new JiraIssues({ cacheDir: dir, baseUrl: 'https://jira.example.com', env: { JIRA_PAT: 'pat' }, fetchImpl: f.fetchImpl });
  await server.getRef({ id: 'OPS-8' });
  assert.equal(f.calls.at(-1).headers.authorization, 'Bearer pat');
  assert.equal(new JiraIssues({ cacheDir: dir, env: {} }).valid({ id: 'OPS-1' }), false); // URL が無ければ扱わない
});

test('Backlog: API キーはヘッダーで送り、コメントは form で投稿する', async (t) => {
  const dir = await tmp(t);
  const f = fake((url, o) => {
    if (o.method === 'POST') return { status: 201, body: { id: 555 } };
    return { body: { issueKey: 'PROJ-3', summary: '検索が遅い', status: { id: 2, name: '処理中' }, assignee: { name: '佐藤' }, category: [{ name: 'バックエンド' }], issueType: { name: 'タスク' }, updated: '2026-10-01T00:00:00Z' } };
  });
  const bl = new BacklogIssues({ cacheDir: dir, space: 'https://acme.backlog.jp/', env: { BACKLOG_API_KEY: 'key' }, fetchImpl: f.fetchImpl });
  const e = await bl.getRef({ id: 'PROJ-3' });
  assert.equal(f.calls[0].url, 'https://acme.backlog.jp/api/v2/issues/PROJ-3'); // キーは URL に載せない
  assert.equal(f.calls[0].headers['backlog-api-key'], 'key');
  assert.deepEqual([e.data.title, e.data.kindLabel, e.data.stateLabel, e.data.stateCategory, e.data.labels[0].name, e.data.url], ['検索が遅い', 'タスク', '処理中', 'in_progress', 'バックエンド', 'https://acme.backlog.jp/view/PROJ-3']);
  const posted = await bl.comment({ id: 'PROJ-3' }, '本文 & 記号');
  assert.equal(f.calls.at(-1).headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(new URLSearchParams(f.calls.at(-1).body).get('content'), '本文 & 記号');
  assert.equal(posted.url, 'https://acme.backlog.jp/view/PROJ-3#comment-555');
  assert.equal(new BacklogIssues({ cacheDir: dir, space: 'evil.example.com', env: {} }).configured(), false); // Backlog のドメイン以外は使わない
});

test('IDの検出: GitLab の URL と MR、Backlog の URL', () => {
  const m = refsFromText('https://gitlab.com/acme/shop/app/-/merge_requests/5 と https://gitlab.example.com/g/p/-/issues/3 と https://acme.backlog.jp/view/PROJ_X-12 と !9', 'prompt', cfg);
  assert.deepEqual([...m.values()].map((r) => [r.id, r.host || null, r.mr || false]), [
    ['PROJ_X-12', null, false],
    ['acme/shop/app!5', 'gitlab.com', true],
    ['g/p#3', 'gitlab.example.com', false],
    ['!9', null, true],
  ]);
});

test('振り分け: URL → 設定のプレフィックス → 設定済みのサービスが1つならそれ', async (t) => {
  const dir = await tmp(t);
  const trk = new Trackers({ cacheDir: dir, env: { LINEAR_API_KEY: 'k' }, config: { jira: { baseUrl: 'https://acme.atlassian.net', keys: ['OPS'] }, backlog: { space: 'acme.backlog.jp', keys: ['PROJ'] } } });
  const r = (ref, extra = {}) => resolveRef(ref, { cfg, trackers: trk, ...extra });
  assert.equal(r({ id: 'ENG-1', kind: 'key', url: 'https://linear.app/acme/issue/ENG-1' }).provider, 'linear');
  assert.equal(r({ id: 'ENG-1', kind: 'key', url: 'https://acme.backlog.jp/view/ENG-1' }).provider, 'backlog');
  const ops = r({ id: 'OPS-2', kind: 'key' });
  assert.deepEqual([ops.provider, ops.url], ['jira', 'https://acme.atlassian.net/browse/OPS-2']);
  assert.equal(r({ id: 'PROJ-3', kind: 'key' }).url, 'https://acme.backlog.jp/view/PROJ-3');
  assert.equal(r({ id: 'ENG-4', kind: 'key' }).provider, null); // 3つとも設定済みでプレフィックスの指定が無い → 決めない
  const onlyLinear = new Trackers({ cacheDir: dir, env: { LINEAR_API_KEY: 'k' }, config: { linear: { workspace: 'acme' } } });
  const eng = resolveRef({ id: 'ENG-4', kind: 'key' }, { cfg, trackers: onlyLinear });
  assert.deepEqual([eng.provider, eng.url], ['linear', 'https://linear.app/acme/issue/ENG-4']);

  // リポジトリの番号はリモートのホストで決まる。GitHub の "!12" は捨てる
  const gl = repoInfoOf('https://gitlab.com/acme/shop/app');
  assert.deepEqual(gl, { host: 'gitlab.com', path: 'acme/shop/app' });
  const mr = r({ id: '!12', kind: 'github', number: 12, mr: true }, { repoInfo: gl });
  assert.deepEqual([mr.provider, mr.id, mr.label, mr.url], ['gitlab', 'acme/shop/app!12', 'app!12', 'https://gitlab.com/acme/shop/app/-/merge_requests/12']);
  assert.equal(r({ id: '#3', kind: 'github', number: 3 }, { repoInfo: gl }).provider, 'gitlab');
  assert.equal(r({ id: '!12', kind: 'github', number: 12, mr: true }, { repoInfo: { host: 'github.com', path: 'a/b' } }), null);
  // 設定していない GitLab のホストはリンクだけ作り、API には問い合わせない
  const self = r({ id: '#3', kind: 'github', number: 3 }, { repoInfo: { host: 'gitlab.example.com', path: 'g/p' } });
  assert.deepEqual([self.provider, self.url], [null, 'https://gitlab.example.com/g/p/-/issues/3']);
});

test('作業記録の書式: Markdown / Jira / プレーンテキスト', () => {
  const t = {
    activeMs: 80 * 60000, commits: 1, first: '2026-10-01T01:00:00Z', last: '2026-10-01T02:30:00Z',
    sessions: [{ start: '2026-10-01T01:00:00Z', title: 'A | B [x]', tool: 'claude', activeMs: 80 * 60000, commits: 1, hashes: ['abc1234'] }],
  };
  const md = buildWorkLog(t, { timeZone: 'UTC' });
  assert.match(md, /\| 10\/1 01:00 \| A \\\| B \[x\] \| Claude Code \| 1時間20分 \| 1 \(abc1234\) \|/);
  const jira = buildWorkLog(t, { format: 'jira', timeZone: 'UTC' });
  assert.match(jira, /^h3\. 作業記録/);
  assert.match(jira, /\|\|開始\|\|セッション\|\|/);
  assert.match(jira, /\|A ｜ B ［x］\|Claude Code\|/); // 表や記法を崩す文字は全角に
  const plain = buildWorkLog(t, { format: 'plain', timeZone: 'UTC' });
  assert.ok(plain.includes('・10/1 01:00 A | B [x](Claude Code、1時間20分、1コミット abc1234)'), plain);
  assert.doesNotMatch(plain, /\|---/);
});

test('ストア経由: 設定に従って Linear と Jira の課題を取得し、書式を変えてコメントする', async (t) => {
  const root = await tmp(t);
  const repo = path.join(root, 'app');
  await mkdir(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const proj = path.join(root, 'projects', '-app');
  await mkdir(proj, { recursive: true });
  const line = (o) => JSON.stringify({ sessionId: 's', cwd: repo, ...o });
  await writeFile(path.join(proj, 's1.jsonl'), [
    line({ type: 'user', gitBranch: 'fix/ENG-12-login', timestamp: '2026-10-01T01:00:00Z', message: { role: 'user', content: 'ログインを直して。関連 OPS-7' } }),
    line({ type: 'assistant', timestamp: '2026-10-01T01:20:00Z', message: { id: 'a', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [] } }),
  ].join('\n'));
  await mkdir(path.join(root, 'cache'), { recursive: true });
  await writeFile(path.join(root, 'cache', 'config.json'), JSON.stringify({ tasks: { linear: { keys: ['ENG'] }, jira: { baseUrl: 'https://acme.atlassian.net', keys: ['OPS'] } } }));

  const f = fake((url, o) => {
    if (url.startsWith('https://api.linear.app')) {
      const q = JSON.parse(o.body);
      if (q.query.includes('commentCreate')) return { body: { data: { commentCreate: { success: true, comment: { url: 'https://linear.app/c/1' } } } } };
      return { body: { data: { issue: { identifier: 'ENG-12', title: 'ログイン', url: 'https://linear.app/acme/issue/ENG-12/login', state: { name: 'Done', type: 'completed' }, labels: { nodes: [] }, assignee: null } } } };
    }
    if (o.method === 'POST') return { status: 201, body: { id: '1' } };
    return { body: { fields: { summary: '請求', status: { name: 'To Do', statusCategory: { key: 'new' } }, labels: [], issuetype: { name: 'Task' } } } };
  });
  const env = { LINEAR_API_KEY: 'lin', JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 't' };
  const store = new Store({ projectsDir: path.join(root, 'projects'), cacheDir: path.join(root, 'cache'), github: new GitHubIssues({ cacheDir: path.join(root, 'cache'), env: {}, tokenProvider: async () => null }) });
  // テストでは環境変数とAPIの代わりを差し込む
  store.trackers.env = env;
  store.trackers.fetchImpl = f.fetchImpl;
  await store.scan();

  const tasks = await store.tasks({});
  const byId = Object.fromEntries(tasks.map((x) => [x.id, x]));
  assert.deepEqual([byId['ENG-12'].provider, byId['ENG-12'].issue.stateLabel, byId['ENG-12'].issue.stateCategory], ['linear', 'Done', 'done']);
  assert.deepEqual([byId['OPS-7'].provider, byId['OPS-7'].url, byId['OPS-7'].issue.title], ['jira', 'https://acme.atlassian.net/browse/OPS-7', '請求']);

  const jc = await store.issueComment('OPS-7', { timeZone: 'UTC' });
  assert.equal(jc.provider, 'jira');
  assert.match(jc.body, /^h3\. 作業記録/);
  const lc = await store.issueComment('ENG-12', { timeZone: 'UTC' });
  assert.match(lc.body, /^### 作業記録/);
  assert.notEqual(jc.hash, lc.hash);

  const server = createServer(store, { env: {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const preview = await (await fetch(`${base}/api/tasks/comment?id=ENG-12&tz=UTC`)).json();
  assert.deepEqual([preview.provider, preview.providerLabel, preview.target, preview.authenticated], ['linear', 'Linear', 'ENG-12', true]);
  const res = await fetch(`${base}/api/tasks/comment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'ENG-12', hash: preview.hash, tz: 'UTC' }) });
  assert.deepEqual(await res.json(), { url: 'https://linear.app/c/1' });
  const cfgRes = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(cfgRes.trackers.map((x) => [x.name, x.configured, x.authenticated]), [
    ['github', true, false], ['gitlab', true, false], ['linear', true, true], ['jira', true, true], ['backlog', false, false],
  ]);
});
