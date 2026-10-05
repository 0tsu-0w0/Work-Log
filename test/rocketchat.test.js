import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RocketChat } from '../src/rocketchat.js';
import { buildReport, toRocketChat, sessionEndRocketChat, plainFromRocketChat } from '../src/report.js';
import { range, one, storeTests } from './dest-helpers.js';

const HOOK = 'https://chat.example.com/hooks/ID123abc/TOKENsecret456';

function fakeRc({ status = 200, body = { success: true }, headers = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, o) => {
    calls.push({ url, ...o });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { calls, fetchImpl };
}

test('https の /hooks/<id>/<token> の Webhook の URL だけを受け付ける(ホストは自由)', () => {
  const ok = (u, extra = {}) => new RocketChat({ env: { ROCKETCHAT_WEBHOOK_URL: u, ...extra } }).status().configured;
  assert.equal(ok(HOOK), true);
  assert.equal(ok('https://rc.corp.example/sub/hooks/ID/tok%2Fen'), true);
  assert.equal(ok('https://chat.example.com/hooks/ID'), false); // token が無い
  assert.equal(ok('https://chat.example.com/api/v1/chat.postMessage'), false);
  assert.equal(ok('http://chat.example.com/hooks/ID/tok'), false);
  assert.equal(ok('not a url'), false);
  assert.equal(ok('http://127.0.0.1:9/hooks/ID/tok', { WORKLOG_ROCKETCHAT_WEBHOOK_ANY: '1' }), true); // テスト用
  assert.deepEqual(new RocketChat({ env: { ROCKETCHAT_WEBHOOK_URL: HOOK } }).status(), { configured: true, mode: 'webhook', destination: 'Webhook', includeCost: false, notify: null });
});

test('送信: { text } を POST し、エラーと制限を伝える', async () => {
  const f = fakeRc();
  const c = new RocketChat({ env: { ROCKETCHAT_WEBHOOK_URL: HOOK }, fetchImpl: f.fetchImpl });
  assert.deepEqual(await c.post({ text: 'こんにちは' }), { url: null });
  assert.equal(f.calls[0].url, HOOK);
  assert.equal(f.calls[0].redirect, 'error');
  assert.deepEqual(JSON.parse(f.calls[0].body), { text: 'こんにちは' });
  const err = (o) => new RocketChat({ env: { ROCKETCHAT_WEBHOOK_URL: HOOK }, fetchImpl: fakeRc(o).fetchImpl }).post({ text: 'x' });
  await assert.rejects(err({ status: 429, body: {}, headers: { 'retry-after': '2' } }), /2秒後/);
  await assert.rejects(err({ status: 400, body: { success: false, error: 'Invalid integration id or token provided.' } }), /Rocket\.Chat Webhook 400: Invalid integration/);
  await assert.rejects(err({ status: 200, body: { success: false, error: 'unknown-error' } }), /unknown-error/);
  await assert.rejects(new RocketChat({ env: {} }).post({ text: 'x' }), /ROCKETCHAT_WEBHOOK_URL/);
});

test('Markdown: 書式・メンション・チャンネル参照になる記号を全角にし、タスクはリンクにする', () => {
  const r = buildReport({
    sessions: [one(1, '@all @here @taro #general *太字* _x_ ~y~ `z` [a](b) <b>')],
    tasks: [{ id: 'WEB-1', label: 'WEB-1', url: 'https://x.example/browse/WEB-1?a=(b)', issue: { title: 'A_B', stateLabel: 'Done' }, sessions: [{ id: 's1' }] }],
    costs: { buckets: [{ usd: 2 }] },
    range,
  });
  const m = toRocketChat(r, { includeCost: true });
  assert.ok(m.text.startsWith('*Work Log 日報 2026/10/4(日)*\n作業 20分・1セッション・0コミット・API換算 $2.00(参考値)\n\n*プロジェクト別*\n• web  20分'), m.text);
  assert.ok(m.text.includes('＠all ＠here ＠taro ＃general ＊太字＊ ＿x＿ ～y～ ｀z｀ ［a］(b) ＜b＞'), m.text);
  assert.doesNotMatch(m.text, /@|#/);
  assert.ok(m.text.includes('• [WEB-1](https://x.example/browse/WEB-1?a=%28b%29) A＿B(Done)  20分'), m.text);
  assert.equal(m.preview, m.text);
  assert.doesNotMatch(toRocketChat(r).text, /\$/);
  assert.equal(plainFromRocketChat('*見出し*\n• [WEB-1](https://a) A'), '見出し\n• WEB-1 (https://a) A');
});

test('Markdown: 5000 文字の上限に収める', () => {
  const many = Array.from({ length: 400 }, (_, i) => one(i, 'とても長いセッションのタイトル'.repeat(8)));
  const m = toRocketChat(buildReport({ sessions: many, range }), { maxSessions: 400 });
  assert.ok([...m.text].length <= 5000);
  assert.match(m.text, /ほか \d+ セッション$/);
});

test('セッション終了の通知(Rocket.Chat)', () => {
  const m = sessionEndRocketChat({ displayTitle: 'ログイン修正', project: 'web', activeMs: 25 * 60000, commits: 1, tasks: [{ label: '#12', url: 'https://github.com/a/b/issues/12' }, { label: 'X', url: 'javascript:alert(1)' }] });
  assert.deepEqual(m, { text: '*セッション終了: ログイン修正*\nweb・25分・1コミット\nタスク: [＃12](https://github.com/a/b/issues/12), X' });
});

let last;
storeTests('rocketchat', {
  make: () => {
    const f = fakeRc();
    last = f;
    return { client: new RocketChat({ env: { ROCKETCHAT_WEBHOOK_URL: HOOK }, fetchImpl: f.fetchImpl }), sent: () => f.calls.map((c) => c.body) };
  },
  secret: 'TOKENsecret456',
  sentText: () => last.calls.map((c) => JSON.parse(c.body).text).join('\n'),
  endPattern: /^\*セッション終了: ［GITHUB＿TOKEN］ を使う修正\*/,
});
