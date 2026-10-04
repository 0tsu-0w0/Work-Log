import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { GitHubIssues, pickIssue } from '../src/github.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

const ISSUE = {
  title: 'カートの合計がずれる',
  state: 'open',
  state_reason: null,
  labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'x', color: 'red;background:url(x)' }],
  assignees: [{ login: 'me' }],
  html_url: 'https://github.com/acme/web/issues/12',
  comments: 2,
  updated_at: '2026-10-01T00:00:00Z',
  closed_at: null,
};

// GitHub API の代わり。呼ばれた内容を記録する
function fakeGitHub(routes) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, ...opts });
    const r = routes(url, opts, calls.length);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status || 200, headers: r.headers || {} });
  };
  return { calls, fetchImpl };
}

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'work-log-gh-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('issue / PR の必要な項目だけを取り出す', () => {
  const i = pickIssue(ISSUE);
  assert.deepEqual([i.title, i.state, i.isPR, i.labels, i.assignees], ['カートの合計がずれる', 'open', false, [{ name: 'bug', color: 'd73a4a' }, { name: 'x', color: null }], ['me']]);
  const pr = pickIssue({ ...ISSUE, state: 'closed', draft: false, pull_request: { merged_at: '2026-10-02T00:00:00Z' } });
  assert.deepEqual([pr.state, pr.isPR], ['merged', true]);
  assert.equal(pickIssue({ ...ISSUE, state: 'closed', state_reason: 'not_planned' }).stateReason, 'not_planned');
});

test('キャッシュと ETag で取り直しを減らす', async (t) => {
  const dir = await tmp(t);
  const gh = fakeGitHub((url, opts) => (opts.headers['if-none-match'] === '"v1"' ? { status: 304 } : { body: ISSUE, headers: { etag: '"v1"' } }));
  const client = new GitHubIssues({ cacheDir: dir, env: { GITHUB_TOKEN: 'tkn' }, fetchImpl: gh.fetchImpl, apiBase: 'https://api.example' });
  const now = Date.parse('2026-10-04T00:00:00Z');
  const a = await client.get('acme/web', 12, { now });
  assert.equal(a.data.title, 'カートの合計がずれる');
  assert.equal(gh.calls[0].url, 'https://api.example/repos/acme/web/issues/12');
  assert.equal(gh.calls[0].headers.authorization, 'Bearer tkn');
  await client.get('acme/web', 12, { now: now + 60 * 1000 }); // 新しいうちは聞きに行かない
  assert.equal(gh.calls.length, 1);
  const b = await client.get('acme/web', 12, { now: now + 11 * 60 * 1000 }); // 開いている issue は10分で再確認
  assert.equal(gh.calls.length, 2);
  assert.equal(gh.calls[1].headers['if-none-match'], '"v1"');
  assert.equal(b.data.title, 'カートの合計がずれる'); // 304 なら前の内容を使う
  await client.save();
  const saved = JSON.parse(await readFile(path.join(dir, 'github.json'), 'utf8'));
  assert.equal(saved['acme/web#12'].etag, '"v1"');
  assert.equal(await client.get('../x', 1), null); // 不正なリポジトリ名は問い合わせない
});

test('見つからない・API 制限・通信失敗', async (t) => {
  const dir = await tmp(t);
  let mode = 'ok';
  const gh = fakeGitHub(() =>
    mode === 'ok' ? { body: ISSUE } : mode === 'limit' ? { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' } } : { status: 404, body: {} });
  const client = new GitHubIssues({ cacheDir: dir, env: {}, tokenProvider: async () => null, fetchImpl: gh.fetchImpl });
  const now = Date.parse('2026-10-04T00:00:00Z');
  assert.equal((await client.get('acme/web', 1, { now })).data.title, ISSUE.title);
  assert.equal(gh.calls[0].headers.authorization, undefined); // トークンが無ければ未認証で
  mode = 'missing';
  assert.equal((await client.get('acme/web', 2, { now })).error, 'not_found');
  mode = 'limit';
  const limited = await client.get('acme/web', 1, { now: now + 25 * 3600 * 1000, force: true });
  assert.equal(limited.error, 'rate_limited');
  assert.equal(limited.data.title, ISSUE.title); // 前に取れた内容は残す
  const calls = gh.calls.length;
  await client.get('acme/web', 3, { now: now + 25 * 3600 * 1000 }); // 制限が解けるまで問い合わせない
  assert.equal(gh.calls.length, calls);

  const down = new GitHubIssues({ cacheDir: dir, env: {}, tokenProvider: async () => null, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal((await down.get('acme/web', 9)).error, 'network');
});

test('まとめて取得し、待ち時間を過ぎたら分かっている内容で返す', async (t) => {
  const dir = await tmp(t);
  let release;
  const slow = new Promise((r) => (release = r));
  const client = new GitHubIssues({
    cacheDir: dir, env: {}, tokenProvider: async () => null,
    fetchImpl: async (url) => {
      if (url.endsWith('/2')) await slow;
      return new Response(JSON.stringify({ ...ISSUE, title: url }), { status: 200 });
    },
  });
  let updated = false;
  const r = await client.getMany([{ repo: 'a/b', number: 1 }, { repo: 'a/b', number: 2 }, { repo: 'a/b', number: 1 }], { waitMs: 50, onUpdate: () => (updated = true) });
  assert.ok(r['a/b#1'].data);
  assert.equal(r['a/b#2'], null);
  release();
  await new Promise((res) => setTimeout(res, 20));
  assert.ok(updated); // 遅れて取れたら画面に知らせる
});

test('作業記録のコメント: プレビューと同じ内容だけを投稿する', async (t) => {
  const root = await tmp(t);
  const repo = path.join(root, 'web');
  await mkdir(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/web.git'], { cwd: repo });
  const proj = path.join(root, 'projects', '-web');
  await mkdir(proj, { recursive: true });
  const line = (o) => JSON.stringify({ sessionId: 's', cwd: repo, ...o });
  await writeFile(path.join(proj, 's1.jsonl'), [
    line({ type: 'user', gitBranch: '12-cart', timestamp: '2026-10-01T01:00:00Z', message: { role: 'user', content: 'カート | 合計を直して token=abcdefgh123' } }),
    line({ type: 'assistant', timestamp: '2026-10-01T01:20:00Z', message: { id: 'a', model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'g', name: 'Bash', input: { command: 'git commit -m fix' } }] } }),
    line({ type: 'user', timestamp: '2026-10-01T01:20:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'g', content: '[12-cart abc1234] fix' }] } }),
  ].join('\n'));

  const gh = fakeGitHub((url, opts) => (opts.method === 'POST' ? { status: 201, body: { html_url: 'https://github.com/acme/web/issues/12#issuecomment-1' } } : { body: ISSUE }));
  const github = new GitHubIssues({ cacheDir: path.join(root, 'cache'), env: { GITHUB_TOKEN: 'tkn' }, fetchImpl: gh.fetchImpl });
  const store = new Store({ projectsDir: path.join(root, 'projects'), cacheDir: path.join(root, 'cache'), github });
  await store.scan();

  const [task] = await store.tasks({});
  assert.equal(task.id, 'acme/web#12');
  assert.equal(task.issue.title, 'カートの合計がずれる');

  const c = await store.issueComment('acme/web#12');
  assert.equal(c.repo, 'acme/web');
  assert.match(c.body, /1セッション・作業 20分・1コミット/);
  assert.match((await store.issueComment('acme/web#12', { timeZone: 'Asia/Tokyo' })).body, /10\/1 10:00 〜 10\/1 10:20/);
  assert.match((await store.issueComment('acme/web#12', { timeZone: 'UTC' })).body, /10\/1 01:00 〜 10\/1 01:20/);
  assert.match((await store.issueComment('acme/web#12', { timeZone: 'Not/AZone' })).body, /作業記録/);
  assert.match(c.body, /カート \\\| 合計を直して token=\[REDACTED\]/); // 表を壊す | は逃がし、秘匿情報は伏せる
  assert.match(c.body, /\(abc1234\)/);
  await assert.rejects(store.postIssueComment('acme/web#12', 'wrong'), (e) => e.status === 409);
  await assert.rejects(store.issueComment('WEB-1'), /タスクが見つかりません/);

  const server = createServer(store, { env: {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const preview = await (await fetch(`${base}/api/tasks/comment?id=${encodeURIComponent('acme/web#12')}`)).json();
  assert.equal(preview.github.authenticated, true);
  assert.equal(preview.hash, c.hash);
  const posted = await fetch(`${base}/api/tasks/comment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'acme/web#12', hash: preview.hash }) });
  assert.equal(posted.status, 200);
  assert.equal((await posted.json()).url, 'https://github.com/acme/web/issues/12#issuecomment-1');
  const post = gh.calls.find((x) => x.method === 'POST');
  assert.equal(post.url, 'https://api.github.com/repos/acme/web/issues/12/comments');
  assert.equal(JSON.parse(post.body).body, c.body);
  // 詳細パネル用のタスクにも issue の情報が付く
  const detail = await (await fetch(`${base}/api/sessions/s1`)).json();
  assert.equal(detail.tasks[0].issue.state, 'open');

  // トークンが無ければ投稿しない
  const anon = new GitHubIssues({ cacheDir: path.join(root, 'cache2'), env: {}, tokenProvider: async () => null, fetchImpl: gh.fetchImpl });
  await assert.rejects(anon.comment('acme/web', 12, 'x'), /トークンが必要/);
});
