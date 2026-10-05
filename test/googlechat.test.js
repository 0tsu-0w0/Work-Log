import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GoogleChat } from '../src/googlechat.js';
import { periodRange, buildReport, toGoogleChat, sessionEndGoogleChat, plainFromGoogleChat } from '../src/report.js';
import { GitHubIssues } from '../src/github.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

const HOOK = 'https://chat.googleapis.com/v1/spaces/AAAAbcdEFg/messages?key=KEYXYZ&token=SECRETTOKEN';

function fakeChat({ status = 200, body = { name: 'spaces/AAAAbcdEFg/messages/x.y', thread: { name: 'spaces/AAAAbcdEFg/threads/x' } }, headers = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, o) => {
    calls.push({ url, ...o });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { calls, fetchImpl };
}

test('Google Chat のスペースの Webhook の URL だけを受け付ける', () => {
  const ok = (u, extra = {}) => new GoogleChat({ env: { GOOGLE_CHAT_WEBHOOK_URL: u, ...extra } }).status().configured;
  assert.equal(ok(HOOK), true);
  assert.equal(ok('https://chat.googleapis.com/v1/spaces/A/members?key=k'), false);
  assert.equal(ok('https://chat.googleapis.com.evil.example/v1/spaces/A/messages'), false);
  assert.equal(ok('http://chat.googleapis.com/v1/spaces/A/messages'), false);
  assert.equal(ok('not a url'), false);
  assert.equal(ok('http://127.0.0.1:9/x', { WORKLOG_GOOGLE_CHAT_WEBHOOK_ANY: '1' }), true); // テスト用
  assert.deepEqual(new GoogleChat({ env: { GOOGLE_CHAT_WEBHOOK_URL: HOOK } }).status(), { configured: true, mode: 'webhook', destination: 'Webhook', includeCost: false, notify: null });
});

test('送信: { text } を POST し、エラーと制限を伝える', async () => {
  const f = fakeChat();
  const g = new GoogleChat({ env: { GOOGLE_CHAT_WEBHOOK_URL: HOOK }, fetchImpl: f.fetchImpl });
  assert.deepEqual(await g.post({ text: 'こんにちは' }), { url: null });
  assert.equal(f.calls[0].url, HOOK);
  assert.equal(f.calls[0].redirect, 'error');
  assert.equal(f.calls[0].headers['content-type'], 'application/json; charset=UTF-8');
  assert.deepEqual(JSON.parse(f.calls[0].body), { text: 'こんにちは' });
  const err = (o) => new GoogleChat({ env: { GOOGLE_CHAT_WEBHOOK_URL: HOOK }, fetchImpl: fakeChat(o).fetchImpl }).post({ text: 'x' });
  await assert.rejects(err({ status: 429, body: {}, headers: { 'retry-after': '2' } }), /2秒後/);
  await assert.rejects(err({ status: 400, body: { error: { code: 400, message: 'Invalid JSON payload', status: 'INVALID_ARGUMENT' } } }), /Google Chat Webhook 400: Invalid JSON payload/);
  // 2026-10-04 に実在しないスペースへ送ったときの実際の応答
  await assert.rejects(err({ status: 403, body: { error: { code: 403, message: "Permission denied to perform the requested action on the specified resource, or the resource doesn't exist.", status: 'PERMISSION_DENIED' } } }), /403\(Webhook の URL が違うか、スペースから削除されています\): Permission denied/);
  await assert.rejects(new GoogleChat({ env: {} }).post({ text: 'x' }), /GOOGLE_CHAT_WEBHOOK_URL/);
});

const range = periodRange({ period: 'day', date: '2026-10-04', timeZone: 'UTC' });
const one = (i, title = `作業${i}`) => ({
  id: `s${i}`, displayTitle: title, project: 'web', start: '2026-10-04T01:00:00Z',
  segments: [{ start: '2026-10-04T01:00:00Z', end: '2026-10-04T01:20:00Z' }], commitList: [], quietCommits: [],
});

test('テキスト: 書式やメンションになる記号を無害にし、タスクはリンクにする', () => {
  const r = buildReport({
    sessions: [one(1, '*太字* _x_ ~y~ `z` <users/all> a|b')],
    tasks: [{ id: 'WEB-1', label: 'WEB-1', url: 'https://x.example/browse/WEB-1?a=<b>', issue: { title: 'A_B', stateLabel: 'Done' }, sessions: [{ id: 's1' }] }],
    costs: { buckets: [{ usd: 2 }] },
    range,
  });
  const m = toGoogleChat(r, { includeCost: true });
  assert.ok(m.text.startsWith('*Work Log 日報 2026/10/4(日)*\n作業 20分・1セッション・0コミット・API換算 $2.00(参考値)'), m.text);
  assert.ok(m.text.includes('＊太字＊ ＿x＿ ～y～ ｀z｀ ＜users/all＞ a｜b'), m.text);
  assert.doesNotMatch(m.text, /<users/);
  assert.ok(m.text.includes('• <https://x.example/browse/WEB-1?a=%3Cb%3E|WEB-1> A＿B(Done)  20分'), m.text);
  assert.equal(m.preview, m.text);
  assert.doesNotMatch(toGoogleChat(r).text, /\$/); // コストは指定したときだけ
  assert.equal(plainFromGoogleChat('*見出し*\n• <https://a|WEB-1> A'), '見出し\n• WEB-1 (https://a) A');
});

test('テキスト: 32,000 バイトの上限に収める', () => {
  const many = Array.from({ length: 400 }, (_, i) => one(i, 'とても長いセッションのタイトル'.repeat(8)));
  const m = toGoogleChat(buildReport({ sessions: many, range }), { maxSessions: 400 });
  assert.ok(Buffer.byteLength(JSON.stringify({ text: m.text })) <= 32000);
  assert.match(m.text, /ほか \d+ セッション$/);
});

test('セッション終了の通知(Google Chat)', () => {
  const m = sessionEndGoogleChat({ displayTitle: 'ログイン修正', project: 'web', activeMs: 25 * 60000, commits: 1, tasks: [{ label: '#12', url: 'https://github.com/a/b/issues/12' }, { label: 'X', url: 'javascript:alert(1)' }] });
  assert.deepEqual(m, { text: '*セッション終了: ログイン修正*\nweb・25分・1コミット\nタスク: <https://github.com/a/b/issues/12|#12>, X' });
});

async function setup(t, config) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-log-gchat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proj = path.join(root, 'projects', '-web');
  await mkdir(proj, { recursive: true });
  await mkdir(path.join(root, 'cache'), { recursive: true });
  if (config) await writeFile(path.join(root, 'cache', 'config.json'), JSON.stringify(config));
  const now = Date.now();
  const iso = (m) => new Date(now - m * 60000).toISOString();
  const line = (o) => JSON.stringify({ sessionId: 's1', cwd: '/nonexistent/web', ...o });
  await writeFile(path.join(proj, 's1.jsonl'), [
    line({ type: 'user', timestamp: iso(40), message: { role: 'user', content: 'ghp_abcdefghijklmnopqrstuvwxyz0123 を使う修正' } }),
    line({ type: 'assistant', timestamp: iso(10), message: { id: 'a', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [] } }),
  ].join('\n'));
  const f = fakeChat();
  const store = new Store({
    projectsDir: path.join(root, 'projects'), cacheDir: path.join(root, 'cache'),
    github: new GitHubIssues({ cacheDir: path.join(root, 'cache'), env: {}, tokenProvider: async () => null }),
    googleChat: new GoogleChat({ env: { GOOGLE_CHAT_WEBHOOK_URL: HOOK }, fetchImpl: f.fetchImpl }),
  });
  await store.scan();
  return { root, store, f, now };
}

test('日報を Google Chat に送る(プレビューと同じ内容だけ、秘匿情報は伏せる)', async (t) => {
  const { store, f } = await setup(t);
  const date = new Date().toISOString().slice(0, 10);
  const r = await store.report({ target: 'googlechat', period: 'day', date, tz: 'UTC' });
  assert.equal(r.target, 'googlechat');
  assert.ok(r.preview.includes('[GITHUB＿TOKEN]'), r.preview);
  assert.doesNotMatch(r.preview, /ghp/);
  const sent = await store.postReport({ target: 'googlechat', period: 'day', date, tz: 'UTC' }, r.hash);
  assert.equal(sent.url, null);
  assert.deepEqual(Object.keys(JSON.parse(f.calls.at(-1).body)), ['text']); // プレビュー用の文字列は送らない
  assert.doesNotMatch(f.calls.at(-1).body, /ghp_abcdefghij/);

  const server = createServer(store, { env: {} });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const pv = await (await fetch(`${base}/api/report?target=googlechat&period=week&date=${date}&tz=UTC`)).json();
  assert.equal(pv.target, 'googlechat');
  assert.doesNotMatch(pv.previewText, /\*/);
  const res = await fetch(`${base}/api/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'googlechat', period: 'week', date, tz: 'UTC', hash: pv.hash }) });
  assert.equal(res.status, 200);
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.googlechat.configured, true);
  assert.equal(JSON.stringify(cfg).includes('SECRETTOKEN'), false); // Webhook の URL は画面に渡さない
  // 知らない送り先は Slack として扱う(任意のプロパティ名を通さない)
  assert.equal(store.destination('__proto__').name, 'slack');
});

test('セッション終了の通知(Google Chat)は1回だけ', async (t) => {
  const { root, store, f, now } = await setup(t, { googlechat: { notify: 'session_end' } });
  const ev = (event, minutesAgo) => JSON.stringify({ ts: new Date(now - minutesAgo * 60000).toISOString(), event, sessionId: 's1' }) + '\n';
  await appendFile(path.join(root, 'cache', 'events.jsonl'), ev('SessionEnd', 5));
  await store.scan();
  assert.equal(await store.notifySessionEnds(), 1);
  assert.match(JSON.parse(f.calls.at(-1).body).text, /^\*セッション終了: \[GITHUB＿TOKEN\] を使う修正\*/);
  assert.equal(await store.notifySessionEnds(), 0);
});
