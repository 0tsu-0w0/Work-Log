import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Webhook } from '../src/webhook.js';
import { buildReport, toWebhook, sessionEndWebhook } from '../src/report.js';
import { range, one, storeTests } from './dest-helpers.js';

const URL1 = 'https://hooks.zapier.com/hooks/catch/123/SECRETPATH/';

function fakeHook({ status = 200, body = 'ok', headers = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, o) => {
    calls.push({ url, ...o });
    return new Response(body, { status, headers });
  };
  return { calls, fetchImpl };
}

test('https の URL と、手元(localhost / 127.0.0.1)の http だけを受け付ける', () => {
  const ok = (u) => new Webhook({ env: { WORKLOG_WEBHOOK_URL: u } }).status().configured;
  assert.equal(ok(URL1), true);
  assert.equal(ok('http://localhost:5678/webhook/x'), true);
  assert.equal(ok('http://127.0.0.1:5678/webhook/x'), true);
  assert.equal(ok('http://hooks.example.com/x'), false);
  assert.equal(ok('http://127.0.0.1.evil.example/x'), false);
  assert.equal(ok('ftp://localhost/x'), false);
  assert.equal(ok('not a url'), false);
  // 状態に出すのはホストだけ(パスに鍵が入ることがある)
  assert.deepEqual(new Webhook({ env: { WORKLOG_WEBHOOK_URL: URL1 } }).status(), { configured: true, mode: 'webhook', destination: 'hooks.zapier.com', includeCost: false, notify: null });
  assert.equal(new Webhook({ env: { WORKLOG_WEBHOOK_URL: 'https://user:pw@h.example/x' } }).status().destination, 'h.example');
});

test('送信: JSON を POST する。鍵があれば本文の HMAC-SHA256 と時刻を付ける', async () => {
  const f = fakeHook();
  const w = new Webhook({ env: { WORKLOG_WEBHOOK_URL: URL1 }, fetchImpl: f.fetchImpl });
  assert.deepEqual(await w.post({ type: 'x', text: '日本語' }), { url: null });
  assert.equal(f.calls[0].url, URL1);
  assert.equal(f.calls[0].redirect, 'error');
  assert.equal(f.calls[0].headers['content-type'], 'application/json; charset=UTF-8');
  assert.deepEqual(JSON.parse(f.calls[0].body), { type: 'x', text: '日本語' });
  assert.equal(f.calls[0].headers['x-worklog-signature'], undefined);

  const g = fakeHook();
  const s = new Webhook({ env: { WORKLOG_WEBHOOK_URL: URL1, WORKLOG_WEBHOOK_SECRET: 's3cret' }, fetchImpl: g.fetchImpl, now: () => 1790000000999 });
  await s.post({ type: 'x', text: '日本語' });
  const c = g.calls[0];
  assert.equal(c.headers['x-worklog-timestamp'], '1790000000');
  assert.equal(c.headers['x-worklog-signature'], `sha256=${createHmac('sha256', 's3cret').update(c.body).digest('hex')}`);
  assert.match(c.headers['x-worklog-signature'], /^sha256=[0-9a-f]{64}$/);
});

test('送信: エラーと制限を伝える', async () => {
  const err = (o, env = {}) => new Webhook({ env: { WORKLOG_WEBHOOK_URL: URL1, ...env }, fetchImpl: fakeHook(o).fetchImpl }).post({});
  await assert.rejects(err({ status: 429, headers: { 'retry-after': '7' } }), /7秒後/);
  await assert.rejects(err({ status: 500, body: 'Internal  error\nhappened' }), /Webhook 500: Internal error happened/);
  await assert.rejects(new Webhook({ env: {} }).post({}), /WORKLOG_WEBHOOK_URL/);
});

test('日報の JSON: 集計と各セッションを入れ、コストは指定したときだけ。text は要約', () => {
  const r = buildReport({
    sessions: [one(1, 'ログイン修正')],
    tasks: [{ id: 'WEB-1', label: 'WEB-1', url: 'https://x.example/browse/WEB-1', issue: { title: 'A', stateLabel: 'Done' }, sessions: [{ id: 's1' }] }],
    costs: { buckets: [{ usd: 2 }] },
    range,
  });
  const { preview, ...m } = toWebhook(r, { includeCost: true });
  assert.equal(m.type, 'report');
  assert.equal(m.version, 1);
  assert.equal(m.period, 'day');
  assert.deepEqual(m.range, { start: '2026-10-04T00:00:00.000Z', end: '2026-10-05T00:00:00.000Z', startDate: '2026-10-04', timeZone: 'UTC' });
  assert.deepEqual(m.totals, { activeMs: 20 * 60000, sessions: 1, commits: 0, usd: 2 });
  assert.deepEqual(m.projects, [{ project: 'web', activeMs: 20 * 60000, sessions: 1, commits: 0 }]);
  assert.deepEqual(m.tasks, [{ id: 'WEB-1', label: 'WEB-1', url: 'https://x.example/browse/WEB-1', activeMs: 20 * 60000, issue: { title: 'A', state: 'Done' } }]);
  assert.deepEqual(JSON.parse(JSON.stringify(m.sessions)), [{ id: 's1', title: 'ログイン修正', project: 'web', tool: 'claude', start: '2026-10-04T01:00:00Z', activeMs: 20 * 60000, commits: 0 }]);
  assert.ok(m.text.startsWith('Work Log 日報 2026/10/4(日)\n作業 20分・1セッション・0コミット・API 換算 $2.00'), m.text);
  assert.ok(m.text.includes('・01:00 ログイン修正 — web・20分'), m.text);
  assert.deepEqual(JSON.parse(preview), JSON.parse(JSON.stringify(m))); // プレビューは送る JSON と同じ(整形したもの)
  assert.ok(preview.includes('\n  "type": "report"'));
  assert.equal(toWebhook(r).totals.usd, undefined);
  assert.doesNotMatch(toWebhook(r).text, /\$/);
});

test('日報の JSON: sessions は maxSessions で削らず、text だけ削る', () => {
  const r = buildReport({ sessions: Array.from({ length: 30 }, (_, i) => one(i)), range });
  const m = toWebhook(r, { maxSessions: 5 });
  assert.equal(m.sessions.length, 30);
  assert.match(m.text, /ほか 25 セッション$/);
});

test('セッション終了の JSON', () => {
  const s = { id: 's9', displayTitle: 'ログイン修正', title: 'raw', project: 'web', tool: 'codex', start: '2026-10-04T01:00:00Z', end: '2026-10-04T01:25:00Z', activeMs: 25 * 60000, commits: 1, cost: { usd: 1.5 }, tasks: [{ id: '#12', label: '#12', url: 'https://github.com/a/b/issues/12' }, { label: 'X' }] };
  assert.deepEqual(sessionEndWebhook(s), {
    type: 'session_end', version: 1,
    session: { id: 's9', title: 'ログイン修正', project: 'web', tool: 'codex', start: '2026-10-04T01:00:00Z', end: '2026-10-04T01:25:00Z', activeMs: 25 * 60000, commits: 1, tasks: [{ id: '#12', label: '#12', url: 'https://github.com/a/b/issues/12' }, { id: null, label: 'X', url: null }] },
  });
  assert.equal(sessionEndWebhook(s, { includeCost: true }).session.usd, 1.5);
});

let last;
storeTests('webhook', {
  make: () => {
    const f = fakeHook();
    last = f;
    return { client: new Webhook({ env: { WORKLOG_WEBHOOK_URL: URL1, WORKLOG_WEBHOOK_SECRET: 's3cret' }, fetchImpl: f.fetchImpl }), sent: () => f.calls.map((c) => c.body) };
  },
  secret: 'SECRETPATH',
  sentText: () => last.calls.map((c) => c.body).join('\n'),
  endPattern: /"type":"session_end".*"title":"\[GITHUB_TOKEN\] を使う修正"/,
});
