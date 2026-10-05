import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chatwork } from '../src/chatwork.js';
import { buildReport, toChatwork, sessionEndChatwork, plainFromChatwork } from '../src/report.js';
import { range, one, storeTests } from './dest-helpers.js';

const ENV = { CHATWORK_API_TOKEN: 'CWTOKEN123', CHATWORK_ROOM_ID: '98765' };

function fakeChatwork({ status = 200, body = { message_id: '1234' }, headers = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, o) => {
    calls.push({ url, ...o });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { calls, fetchImpl };
}

test('API トークンと数字のルームIDがそろったときだけ設定済みになる', () => {
  const st = (env, cfg) => new Chatwork({ env, config: cfg }).status();
  assert.deepEqual(st(ENV), { configured: true, mode: 'token', destination: 'ルーム 98765', includeCost: false, notify: null });
  assert.equal(st({ CHATWORK_API_TOKEN: 'x' }).configured, false);
  assert.equal(st({ CHATWORK_API_TOKEN: 'x' }, { roomId: '555' }).configured, true); // ルームIDは config.json でもよい
  assert.equal(st({ CHATWORK_API_TOKEN: 'x', CHATWORK_ROOM_ID: '12/../x' }).configured, false);
  assert.equal(st({ CHATWORK_ROOM_ID: '1' }).configured, false);
});

test('送信: body を form で POST し、投稿へのリンクを返す。エラーと制限を伝える', async () => {
  const f = fakeChatwork();
  const c = new Chatwork({ env: ENV, fetchImpl: f.fetchImpl });
  assert.deepEqual(await c.post({ body: '[info]こんにちは & 100%[/info]' }), { url: 'https://www.chatwork.com/#!rid98765-1234' });
  assert.equal(f.calls[0].url, 'https://api.chatwork.com/v2/rooms/98765/messages');
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(f.calls[0].redirect, 'error');
  assert.equal(f.calls[0].headers['x-chatworktoken'], 'CWTOKEN123');
  assert.equal(f.calls[0].headers['content-type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(f.calls[0].body);
  assert.equal(form.get('body'), '[info]こんにちは & 100%[/info]');
  assert.equal(form.get('self_unread'), '0');
  const err = (o) => new Chatwork({ env: ENV, fetchImpl: fakeChatwork(o).fetchImpl }).post({ body: 'x' });
  await assert.rejects(err({ status: 429, body: {}, headers: { 'retry-after': '3' } }), /3秒後/);
  await assert.rejects(err({ status: 429, body: {}, headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 5) } }), /[45]秒後/);
  await assert.rejects(err({ status: 401, body: { errors: ['Invalid API token'] } }), /Chatwork API 401: Invalid API token/);
  await assert.rejects(new Chatwork({ env: {} }).post({ body: 'x' }), /CHATWORK_API_TOKEN/);
  assert.deepEqual(await new Chatwork({ env: ENV, fetchImpl: fakeChatwork({ body: {} }).fetchImpl }).post({ body: 'x' }), { url: null });
});

test('本文: Chatwork の記法になる [ ] を全角にし、タスクは URL を添える', () => {
  const r = buildReport({
    sessions: [one(1, '[To:123] [toall] [info]x[/info] [hr]')],
    tasks: [{ id: 'WEB-1', label: 'WEB-1', url: 'https://x.example/browse/WEB-1?a=[b]', issue: { title: '[A]', stateLabel: 'Done' }, sessions: [{ id: 's1' }] }],
    costs: { buckets: [{ usd: 2 }] },
    range,
  });
  const m = toChatwork(r, { includeCost: true });
  assert.ok(m.body.startsWith('[info][title]Work Log 日報 2026/10/4(日)[/title]作業 20分・1セッション・0コミット・API換算 $2.00(参考値)\n[hr]\nプロジェクト別\n'), m.body);
  assert.ok(m.body.endsWith('[/info]'));
  assert.ok(m.body.includes('・01:00 ［To:123］'), m.body);
  assert.ok(m.body.includes('［To:123］ ［toall］ ［info］x［/info］ ［hr］'), m.body);
  assert.ok(m.body.includes('・WEB-1 https://x.example/browse/WEB-1?a=%5Bb%5D ［A］(Done)  20分'), m.body);
  // 記法として働く [ はテンプレートの [info] [title] [hr] だけ
  assert.deepEqual(m.body.match(/\[[^\]]*\]/g).filter((x, i, a) => a.indexOf(x) === i).sort(), ['[/info]', '[/title]', '[hr]', '[info]', '[title]']);
  assert.equal(m.preview, m.body);
  assert.doesNotMatch(toChatwork(r).body, /\$/);
  assert.equal(plainFromChatwork('[info][title]見出し[/title]本文\n[hr]\n次[/info]'), '見出し\n本文\n────────\n次');
});

test('本文: 文字数の上限に収める', () => {
  const many = Array.from({ length: 800 }, (_, i) => one(i, 'とても長いセッションのタイトル'.repeat(8)));
  const m = toChatwork(buildReport({ sessions: many, range }), { maxSessions: 800 });
  assert.ok([...m.body].length <= 30000);
  assert.match(m.body, /ほか \d+ セッション\n\[hr\]/);
});

test('セッション終了の通知(Chatwork)', () => {
  const m = sessionEndChatwork({ displayTitle: 'ログイン[To:1]修正', project: 'web', activeMs: 25 * 60000, commits: 1, tasks: [{ label: '#12', url: 'https://github.com/a/b/issues/12' }, { label: 'X', url: 'javascript:alert(1)' }] });
  assert.deepEqual(m, { body: '[info][title]セッション終了: ログイン［To:1］修正[/title]web・25分・1コミット\nタスク: #12 https://github.com/a/b/issues/12, X[/info]' });
});

const sentBodies = (calls) => calls.map((c) => new URLSearchParams(c.body).get('body'));
let last;
storeTests('chatwork', {
  make: () => {
    const f = fakeChatwork();
    last = f;
    return { client: new Chatwork({ env: ENV, fetchImpl: f.fetchImpl }), sent: () => f.calls.map((c) => c.body) };
  },
  secret: 'CWTOKEN123',
  sentText: () => sentBodies(last.calls).join('\n'),
  endPattern: /^\[info\]\[title\]セッション終了: ［GITHUB_TOKEN］ を使う修正\[\/title\]/,
});
