import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { extractTaskRefs, refsFromText, refsFromBranch, resolveRef, normalizeConfig, githubRepoOf } from '../src/tasks.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

const cfg = normalizeConfig();
const ids = (map) => [...map.values()].map((r) => r.id);

test('依頼文からタスクIDを拾う', () => {
  assert.deepEqual(ids(refsFromText('WEB-42 のバグを直して。関連: #17 と acme/api#3', 'prompt', cfg)), ['WEB-42', '#17', 'acme/api#3']);
  assert.deepEqual(ids(refsFromText('GH-8 を対応', 'prompt', cfg)), ['#8']);
  // 規格名・モデル名・コード片は拾わない
  assert.deepEqual(ids(refsFromText('UTF-8 と ISO-8601、GPT-5、SHA-256、色 #fff、x-1、a#1', 'prompt', cfg)), []);
  assert.deepEqual(ids(refsFromText('```\nconst a = "WEB-1"; // #12\n```\n本文', 'prompt', cfg)), []);
});

test('課題のURLからIDとリンク先を拾う', () => {
  const m = refsFromText('見て https://linear.app/acme/issue/ENG-12/fix-login と https://acme.atlassian.net/browse/OPS-7 と https://github.com/acme/web/pull/99.', 'prompt', cfg);
  assert.deepEqual([...m.values()].map((r) => [r.id, r.url]), [
    ['ENG-12', 'https://linear.app/acme/issue/ENG-12/fix-login'],
    ['OPS-7', 'https://acme.atlassian.net/browse/OPS-7'],
    ['acme/web#99', 'https://github.com/acme/web/pull/99'],
  ]);
});

test('ブランチ名とコミットの件名から拾う', () => {
  assert.deepEqual(ids(refsFromBranch('fix/WEB-42-login', cfg)), ['WEB-42']);
  assert.deepEqual(ids(refsFromBranch('123-add-cart', cfg)), ['#123']);
  assert.deepEqual(ids(refsFromBranch('feature/45-x', cfg)), ['#45']);
  assert.deepEqual(ids(refsFromBranch('main', cfg)), []);
  assert.deepEqual(ids(refsFromBranch('release/v2', cfg)), []);
  const refs = extractTaskRefs({ prompts: ['WEB-42 を直して'], gitBranch: 'fix/WEB-42', commitList: [{ subject: 'fix login (#50)' }] }, cfg);
  assert.deepEqual(refs.map((r) => [r.id, r.sources]), [['WEB-42', ['prompt', 'branch']], ['#50', ['commit']]]);
});

test('設定でプレフィックスを絞り込み、リンク先を作る', () => {
  const c = normalizeConfig({ tasks: { keys: ['WEB'], urls: { WEB: 'https://acme.atlassian.net/browse/{id}' }, keyUrl: 'https://linear.app/acme/issue/{id}', github: false } });
  assert.deepEqual(ids(refsFromText('WEB-1 と ENG-2 と #3', 'prompt', c)), ['WEB-1']);
  assert.equal(resolveRef({ id: 'WEB-1', kind: 'key' }, { cfg: c }).url, 'https://acme.atlassian.net/browse/WEB-1');
  assert.equal(resolveRef({ id: 'ENG-2', kind: 'key' }, { cfg: c }).url, 'https://linear.app/acme/issue/ENG-2');
  assert.equal(resolveRef({ id: 'ENG-2', kind: 'key' }, { cfg }).url, undefined);
  const gh = resolveRef({ id: '#7', kind: 'github', number: 7 }, { repo: 'acme/web', cfg });
  assert.deepEqual([gh.id, gh.label, gh.url], ['acme/web#7', 'web#7', 'https://github.com/acme/web/issues/7']);
  assert.equal(githubRepoOf('https://github.com/acme/web'), 'acme/web');
  assert.equal(githubRepoOf('https://gitlab.com/acme/web'), null);
});

const line = (o) => JSON.stringify({ sessionId: 's', ...o });
function sessionLog(cwd, branch, prompt, ts) {
  return [
    line({ type: 'user', cwd, gitBranch: branch, timestamp: ts, message: { role: 'user', content: prompt } }),
    line({ type: 'assistant', cwd, timestamp: ts.replace(':00Z', ':30Z'), message: { id: 'a', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [], usage: { input_tokens: 1e6, output_tokens: 0 } } }),
  ].join('\n');
}

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-log-tasks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'web');
  await mkdir(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/web.git'], { cwd: repo });
  const proj = path.join(root, 'projects', '-web');
  await mkdir(proj, { recursive: true });
  await writeFile(path.join(proj, 's1.jsonl'), sessionLog(repo, '12-cart', 'カートの不具合 WEB-42 を直して', '2026-10-01T01:00:00Z'));
  await writeFile(path.join(proj, 's2.jsonl'), sessionLog(repo, 'main', 'WEB-42 の続き。UTF-8 の扱いも', '2026-10-02T01:00:00Z'));
  await writeFile(path.join(proj, 's3.jsonl'), sessionLog(repo, 'main', 'READMEを整える', '2026-10-03T01:00:00Z'));
  const store = new Store({ projectsDir: path.join(root, 'projects'), cacheDir: path.join(root, 'cache') });
  await store.scan();
  return { root, store };
}

test('タスクごとにセッション・時間・コストをまとめ、#番号はリポジトリに解決する', async (t) => {
  const { store } = await setup(t);
  const tasks = await store.tasks({});
  assert.deepEqual(tasks.map((x) => [x.id, x.label, x.url, x.sessions.map((s) => s.id)]), [
    ['WEB-42', 'WEB-42', null, ['s2', 's1']],
    ['acme/web#12', 'web#12', 'https://github.com/acme/web/issues/12', ['s1']],
  ]);
  assert.equal(tasks[0].usd, 8); // Opus 5.5 入力 100万トークン × 2 セッション
  assert.deepEqual(tasks[0].sources, ['prompt']);
  assert.equal((await store.tasks({ from: '2026-10-02T00:00:00Z' }))[0].sessions.length, 1);
});

test('画面から付け外しでき、保存される', async (t) => {
  const { root, store } = await setup(t);
  await store.updateLinks('s3', { add: ['https://linear.app/acme/issue/DOC-5/readme'] });
  await store.updateLinks('s1', { remove: ['WEB-42'] });
  await assert.rejects(store.updateLinks('s3', { add: ['なにか'] }), /タスクIDとして読めません/);
  const tasks = await store.tasks({});
  assert.deepEqual(tasks.find((x) => x.id === 'WEB-42').sessions.map((s) => s.id), ['s2']);
  const doc = tasks.find((x) => x.id === 'DOC-5');
  assert.deepEqual([doc.url, doc.sources], ['https://linear.app/acme/issue/DOC-5/readme', ['manual']]);
  // 外したタスクをもう一度付けると戻る
  await store.updateLinks('s1', { add: ['WEB-42'] });
  assert.equal((await store.tasks({})).find((x) => x.id === 'WEB-42').sessions.length, 2);
  const saved = JSON.parse(await readFile(path.join(root, 'cache', 'links.json'), 'utf8'));
  assert.deepEqual(saved.s1.remove, []);
  const reloaded = new Store({ projectsDir: path.join(root, 'projects'), cacheDir: path.join(root, 'cache') });
  await reloaded.scan();
  assert.ok((await reloaded.tasks({})).some((x) => x.id === 'DOC-5'));
});

function request(port, { method = 'GET', path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('タスクのAPIと、ほかのサイト・ほかのホスト名からの要求の拒否', async (t) => {
  const { store } = await setup(t);
  const server = createServer(store, { env: {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const port = server.address().port;
  const own = { host: `127.0.0.1:${port}` };

  const list = await request(port, { path: '/api/tasks', headers: own });
  assert.equal(list.body.tasks.length, 2);
  const detail = await request(port, { path: '/api/sessions/s1', headers: own });
  assert.deepEqual(detail.body.tasks.map((x) => x.label), ['WEB-42', 'web#12']);
  assert.equal(detail.body.title, 'カートの不具合 WEB-42 を直して');
  assert.equal((await request(port, { path: '/api/sessions?task=WEB-42', headers: own })).body.sessions.length, 2);
  assert.equal((await request(port, { path: '/api/sessions?q=web-42', headers: own })).body.sessions.length, 2);

  const body = JSON.stringify({ add: ['OPS-1'] });
  const ok = await request(port, { method: 'POST', path: '/api/sessions/s3/tasks', headers: { ...own, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.tasks.map((x) => x.id), ['OPS-1']);
  const bad = await request(port, { method: 'POST', path: '/api/sessions/s3/tasks', headers: { ...own, 'content-type': 'application/json' }, body: '{' });
  assert.equal(bad.status, 400);

  // 別のサイト(別ポートの localhost を含む)からの書き込みは断る
  const csrf = await request(port, { method: 'POST', path: '/api/sessions/s3/tasks', headers: { ...own, origin: 'http://localhost:3000' }, body });
  assert.equal(csrf.status, 403);
  // DNS リバインディング: Host が自分でなければ読み取りも断る
  assert.equal((await request(port, { path: '/api/sessions', headers: { host: 'evil.example' } })).status, 403);
  // フック(Origin なし)からの通知は通る
  assert.equal((await request(port, { method: 'POST', path: '/api/hook', headers: own })).status, 200);
});
