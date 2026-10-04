import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { createServer, filterSessions } from '../src/server.js';
import { parseLlmJson } from '../src/summarizer.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', '11111111-2222-3333-4444-555555555555.jsonl');
const ID = '11111111-2222-3333-4444-555555555555';

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-log-'));
  const projectsDir = path.join(root, 'projects');
  const proj = path.join(projectsDir, '-home-dev-myapp');
  await mkdir(proj, { recursive: true });
  const file = path.join(proj, `${ID}.jsonl`);
  await copyFile(FIXTURE, file);
  const store = new Store({ projectsDir, cacheDir: path.join(root, 'cache') });
  return { root, store, file, projectsDir };
}

test('変更のあったファイルだけ再解析し、キャッシュから復元できる', async (t) => {
  const { root, store, file, projectsDir } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await store.scan(), { total: 1, changed: 1, hookEvents: 0 });
  assert.deepEqual(await store.scan(), { total: 1, changed: 0, hookEvents: 0 });

  const line = JSON.stringify({ type: 'user', timestamp: '2026-09-28T03:40:00.000Z', message: { role: 'user', content: 'テストも追加して' } });
  await appendFile(file, line + '\n');
  assert.deepEqual(await store.scan(), { total: 1, changed: 1, hookEvents: 0 });
  assert.equal(store.sessions()[0].userMessages, 3);

  const reloaded = new Store({ projectsDir, cacheDir: path.join(root, 'cache') });
  assert.deepEqual(await reloaded.scan(), { total: 1, changed: 0, hookEvents: 0 });
  assert.equal(reloaded.sessions()[0].userMessages, 3);
});

test('スキャン中に呼ばれたら、終わった後にもう1回スキャンする', async (t) => {
  const { root, store } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));
  let runs = 0;
  const orig = store._scan.bind(store);
  store._scan = async () => {
    runs++;
    return orig();
  };
  const first = store.scan();
  const second = store.scan();
  const third = store.scan();
  await Promise.all([first, second, third]);
  assert.equal(second, third);
  assert.equal(runs, 2);
});

test('進行中の判定', async (t) => {
  const { root, store } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));
  await store.scan();
  const end = Date.parse('2026-09-28T03:31:00.000Z');
  assert.equal(store.sessions(end + 60000)[0].status, 'working');
  assert.equal(store.sessions(end + 10 * 60000)[0].status, 'done');
});

test('LLM要約はキャッシュされ、同じ内容なら再要約しない', async (t) => {
  const { root, store } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));
  await store.scan();
  let calls = 0;
  let sentBody = '';
  const fetchImpl = async (_url, opts) => {
    calls++;
    sentBody = opts.body;
    const text = '{"title":"ログイン修正","summary":"ログインのバグを直した。","workType":"バグ修正","components":["auth"]}';
    return new Response(JSON.stringify({ model: 'm', content: [{ type: 'text', text }] }), { status: 200 });
  };
  const env = { ANTHROPIC_API_KEY: 'x' };
  const v = await store.summarize(ID, { env, fetchImpl });
  assert.equal(v.displayTitle, 'ログイン修正');
  assert.deepEqual(v.components, ['auth']);
  assert.equal(v.summarySource, 'llm');
  await store.summarize(ID, { env, fetchImpl });
  assert.equal(calls, 1);
  await store.summarize(ID, { env, fetchImpl, force: true });
  assert.equal(calls, 2);
  // 送信内容はマスキング済み
  assert.ok(!sentBody.includes('abcd1234secret'));
  assert.ok(sentBody.includes('[REDACTED]'));
});

test('LLM応答からJSONを取り出す', () => {
  assert.deepEqual(parseLlmJson('結果:\n{"summary":"s","workType":"機能","components":["a"]}'), { title: null, summary: 's', workType: '機能', components: ['a'] });
  assert.throws(() => parseLlmJson('no json'));
});

test('フィルタ', () => {
  const base = { start: '2026-09-28T01:00:00Z', end: '2026-09-28T02:00:00Z', project: 'a', workType: '機能', components: ['src/x'], prompts: ['ログイン'], changedFiles: [], displayTitle: 't' };
  const list = [base, { ...base, project: 'b', workType: 'バグ修正', prompts: [] }];
  assert.equal(filterSessions(list, { project: 'b' }).length, 1);
  assert.equal(filterSessions(list, { tag: 'src/x' }).length, 2);
  assert.equal(filterSessions(list, { tag: 'バグ修正' }).length, 1);
  assert.equal(filterSessions(list, { q: 'ログイン' }).length, 1);
  assert.equal(filterSessions(list, { from: '2026-09-28T02:30:00Z' }).length, 0);
  assert.equal(filterSessions(list, { to: '2026-09-28T00:30:00Z' }).length, 0);
});

test('HTTP API', async (t) => {
  const { root, store } = await setup();
  await store.scan();
  const server = createServer(store, { env: {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const list = await (await fetch(`${base}/api/sessions`)).json();
  assert.equal(list.sessions.length, 1);
  assert.deepEqual(list.projects, ['myapp']);
  assert.equal(list.sessions[0].prompts, undefined); // 一覧は軽量

  const detail = await (await fetch(`${base}/api/sessions/${ID}`)).json();
  assert.equal(detail.commits, 1);
  assert.match(detail.firstPrompt, /token=\[REDACTED\]/);

  const sum = await fetch(`${base}/api/sessions/${ID}/summarize`, { method: 'POST' });
  assert.equal(sum.status, 400); // APIキーなし

  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 403);
});
