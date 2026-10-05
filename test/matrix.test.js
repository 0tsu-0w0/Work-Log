import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix } from '../src/matrix.js';
import { buildReport, toMatrix, sessionEndMatrix, plainFromMatrix } from '../src/report.js';
import { range, one, storeTests } from './dest-helpers.js';

const HS = 'https://matrix.example.com';
const TOKEN = 'syt_c2VuZGVy_SecretAccessToken_0123';
const ROOM = '!abcDEF123:example.com';
const ENV = { MATRIX_HOMESERVER: HS, MATRIX_ACCESS_TOKEN: TOKEN, MATRIX_ROOM_ID: ROOM };

// 偽のホームサーバー。responses を順に返す(足りなければ最後のものを繰り返す)
function fakeHs(responses = [{ status: 200, body: { event_id: '$ev1:example.com' } }]) {
  const calls = [];
  const fetchImpl = async (url, o) => {
    calls.push({ url, ...o });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers || {}) } });
  };
  return { calls, fetchImpl };
}

test('設定: https のホームサーバー(http は localhost だけ)・トークン・ルーム ID がそろったときだけ使え、トークンは出さない', () => {
  const st = (env, config) => new Matrix({ env, config }).status();
  assert.deepEqual(st(ENV), { configured: true, mode: 'client-server', destination: `matrix.example.com ${ROOM}`, includeCost: false, notify: null });
  assert.equal(st({ ...ENV, MATRIX_HOMESERVER: 'http://matrix.example.com' }).configured, false);
  assert.equal(st({ ...ENV, MATRIX_HOMESERVER: 'http://localhost:8008' }).configured, true);
  assert.equal(st({ ...ENV, MATRIX_HOMESERVER: 'http://127.0.0.1:8008/' }).configured, true);
  assert.equal(st({ ...ENV, MATRIX_HOMESERVER: 'https://u:p@matrix.example.com' }).configured, false);
  assert.equal(st({ ...ENV, MATRIX_HOMESERVER: 'nope' }).configured, false);
  assert.equal(st({ ...ENV, MATRIX_ACCESS_TOKEN: '' }).configured, false);
  assert.equal(st({ ...ENV, MATRIX_ACCESS_TOKEN: 'a b' }).configured, false);
  assert.equal(st({ ...ENV, MATRIX_ROOM_ID: '#room:example.com' }).configured, false); // 別名は使えない
  assert.equal(st({ ...ENV, MATRIX_ROOM_ID: '!x:example.com/../../admin' }).configured, false);
  assert.equal(st({ ...ENV, MATRIX_ROOM_ID: '!R_FYaCA6XkwSABXAXz41fayhMLfQrQnwsUu6yjw0nAA' }).configured, true); // ルーム v12 の ID(サーバー名なし)
  assert.equal(st({ ...ENV, MATRIX_ROOM_ID: '' }, { roomId: '!other:example.org', notify: 'session_end' }).notify, 'session_end');
  assert.equal(st({ ...ENV, MATRIX_ROOM_ID: '' }, { roomId: '!other:example.org' }).destination, 'matrix.example.com !other:example.org');
  assert.equal(JSON.stringify(st(ENV)).includes(TOKEN), false);
});

test('送信: PUT /rooms/{roomId}/send/m.room.message/{txnId}、Bearer トークン、m.mentions は空、matrix.to のリンクを返す', async () => {
  const f = fakeHs();
  const m = new Matrix({ env: ENV, fetchImpl: f.fetchImpl });
  const r = await m.post({ body: 'こんにちは', formatted_body: '<p>こんにちは</p>' });
  assert.deepEqual(r, { url: 'https://matrix.to/#/!abcDEF123%3Aexample.com/%24ev1%3Aexample.com?via=example.com', eventId: '$ev1:example.com' });
  const c = f.calls[0];
  assert.equal(c.method, 'PUT');
  assert.match(c.url, /^https:\/\/matrix\.example\.com\/_matrix\/client\/v3\/rooms\/!abcDEF123%3Aexample\.com\/send\/m\.room\.message\/worklog\.\d+\.[0-9a-f]{16}$/);
  assert.equal(c.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(c.redirect, 'error');
  assert.deepEqual(JSON.parse(c.body), { msgtype: 'm.notice', body: 'こんにちは', format: 'org.matrix.custom.html', formatted_body: '<p>こんにちは</p>', 'm.mentions': {} });
  await m.post({ body: 'a', formatted_body: 'a' });
  assert.notEqual(f.calls[1].url, c.url); // txnId は送るたびに変える
  m.setConfig({ msgtype: 'm.text' });
  await m.post({ body: 'a', formatted_body: 'a' });
  assert.equal(JSON.parse(f.calls[2].body).msgtype, 'm.text');
  // サブパスのホームサーバーと、サーバー名の無いルーム ID
  const g = fakeHs([{ status: 200, body: { event_id: '$x' } }]);
  const r2 = await new Matrix({ env: { ...ENV, MATRIX_HOMESERVER: 'https://h.example/mx/', MATRIX_ROOM_ID: '!AbC_d-1' }, fetchImpl: g.fetchImpl }).post({ body: 'a', formatted_body: 'a' });
  assert.match(g.calls[0].url, /^https:\/\/h\.example\/mx\/_matrix\/client\/v3\/rooms\/!AbC_d-1\/send\//);
  assert.equal(r2.url, 'https://matrix.to/#/!AbC_d-1/%24x');
});

test('送信: 429 M_LIMIT_EXCEEDED は retry_after_ms だけ待って同じ txnId で送り直し、長すぎる待ちやエラーは伝える', async () => {
  const waits = [];
  const sleepImpl = async (ms) => void waits.push(ms);
  const f = fakeHs([{ status: 429, body: { errcode: 'M_LIMIT_EXCEEDED', error: 'Too Many Requests', retry_after_ms: 1500 } }, { status: 200, body: { event_id: '$ok' } }]);
  const r = await new Matrix({ env: ENV, fetchImpl: f.fetchImpl, sleepImpl }).post({ body: 'a', formatted_body: 'a' });
  assert.equal(r.eventId, '$ok');
  assert.deepEqual(waits, [1500]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, f.calls[1].url); // 同じ txnId(二重に投稿されない)
  // retry_after_ms が無ければ Retry-After ヘッダー
  const h = fakeHs([{ status: 429, body: { errcode: 'M_LIMIT_EXCEEDED' }, headers: { 'retry-after': '2' } }, { status: 200, body: { event_id: '$ok' } }]);
  waits.length = 0;
  await new Matrix({ env: ENV, fetchImpl: h.fetchImpl, sleepImpl }).post({ body: 'a', formatted_body: 'a' });
  assert.deepEqual(waits, [2000]);
  // 待ちが長すぎる・何度も制限される
  const err = (responses) => new Matrix({ env: ENV, fetchImpl: fakeHs(responses).fetchImpl, sleepImpl }).post({ body: 'a', formatted_body: 'a' });
  await assert.rejects(err([{ status: 429, body: { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 60000 } }]), /60秒後に再試行/);
  await assert.rejects(err([{ status: 429, body: { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 100 } }]), /制限されています/);
  await assert.rejects(err([{ status: 401, body: { errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid access token passed.' } }]), /Matrix 401\(アクセストークンが違うか、失効しています\): M_UNKNOWN_TOKEN Invalid access token passed\./);
  await assert.rejects(err([{ status: 403, body: { errcode: 'M_FORBIDDEN', error: 'User not in room' } }]), /Matrix 403\(このユーザーがルームに参加していないか/);
  await assert.rejects(err([{ status: 200, body: {} }]), /Matrix 200/);
  await assert.rejects(new Matrix({ env: {} }).post({ body: 'a' }), /MATRIX_HOMESERVER・MATRIX_ACCESS_TOKEN・MATRIX_ROOM_ID/);
});

test('本文: body と HTML。@ は全角にしてメンションにせず、HTML は逃がし、matrix.to はリンクにしない', () => {
  const r = buildReport({
    sessions: [one(1, '@room @bob:localhost <b>x</b> & "q"')],
    tasks: [
      { id: 'WEB-1', label: 'WEB-1', url: 'https://x.example/browse/WEB-1?a=1&b="2"', issue: { title: 'A<B @here', stateLabel: 'Done' }, sessions: [{ id: 's1' }] },
      { id: 'MX', label: '@bob:localhost', url: 'https://matrix.to/#/@bob:localhost', sessions: [{ id: 's1' }] },
      { id: 'JS', label: 'J', url: 'javascript:alert(1)', sessions: [{ id: 's1' }] },
    ],
    costs: { buckets: [{ usd: 2 }] },
    range,
  });
  const m = toMatrix(r, { includeCost: true });
  assert.ok(m.body.startsWith('Work Log 日報 2026/10/4(日)\n作業 20分・1セッション・0コミット・API換算 $2.00(参考値)\n\n■ プロジェクト別\n・web  20分(1セッション・0コミット)'), m.body);
  assert.ok(m.body.includes('＠room ＠bob:localhost <b>x</b> & "q"'), m.body);
  assert.ok(m.body.includes('・WEB-1 (https://x.example/browse/WEB-1?a=1&b="2") A<B ＠here(Done)'), m.body);
  assert.ok(m.body.includes('・＠bob:localhost  20分'), m.body);
  assert.ok(m.formatted_body.startsWith('<h3>Work Log 日報 2026/10/4(日)</h3>\n<p>作業 20分・1セッション・0コミット・API換算 $2.00(参考値)</p>\n<h4>プロジェクト別</h4>\n<ul>\n<li>web  20分(1セッション・0コミット)</li>\n</ul>'), m.formatted_body);
  assert.ok(m.formatted_body.includes('＠room ＠bob:localhost &lt;b&gt;x&lt;/b&gt; &amp; &quot;q&quot;'), m.formatted_body);
  assert.ok(m.formatted_body.includes('<a href="https://x.example/browse/WEB-1?a=1&amp;b=%222%22">WEB-1</a> A&lt;B ＠here(Done)'), m.formatted_body);
  assert.doesNotMatch(m.formatted_body, /matrix\.to|javascript:|<b>/);
  assert.doesNotMatch(m.body + m.formatted_body, /@/);
  assert.ok(m.formatted_body.endsWith('<p><em>ローカルの AI コーディングツールのセッションログから Work Log で作成</em></p>'));
  assert.equal(m.preview, m.body);
  assert.equal(plainFromMatrix(m.preview), m.body);
  assert.doesNotMatch(toMatrix(r).body, /\$/);
});

test('本文: イベントの上限(65536 バイト)に収める', () => {
  const many = Array.from({ length: 800 }, (_, i) => one(i, 'とても長いセッションのタイトル'.repeat(8)));
  const m = toMatrix(buildReport({ sessions: many, range }), { maxSessions: 800 });
  assert.ok(Buffer.byteLength(JSON.stringify({ body: m.body, formatted_body: m.formatted_body })) <= 56000);
  assert.match(m.body, /ほか \d+ セッション/);
});

test('セッション終了の通知(Matrix)', () => {
  const m = sessionEndMatrix({ displayTitle: 'ログイン修正 @room <i>', project: 'web', activeMs: 25 * 60000, commits: 1, tasks: [{ label: '#12', url: 'https://github.com/a/b/issues/12' }] });
  assert.deepEqual(m, {
    body: 'セッション終了: ログイン修正 ＠room <i>\nweb・25分・1コミット\nタスク: #12 (https://github.com/a/b/issues/12)',
    formatted_body: '<p><strong>セッション終了: ログイン修正 ＠room &lt;i&gt;</strong><br>web・25分・1コミット<br>タスク: <a href="https://github.com/a/b/issues/12">#12</a></p>',
  });
});

let last;
storeTests('matrix', {
  make: () => {
    const f = fakeHs();
    last = f;
    return { client: new Matrix({ env: ENV, fetchImpl: f.fetchImpl }), sent: () => f.calls.map((c) => c.body) };
  },
  secret: TOKEN,
  sentText: () => last.calls.map((c) => JSON.parse(c.body).body).join('\n'),
  endPattern: /^セッション終了: \[GITHUB_TOKEN\] を使う修正/,
});
