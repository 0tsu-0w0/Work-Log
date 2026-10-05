import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mattermost } from '../src/mattermost.js';
import { buildReport, toMattermost, sessionEndMattermost, plainFromMattermost } from '../src/report.js';
import { range, one, storeTests } from './dest-helpers.js';

const HOOK = 'https://chat.example.com/hooks/abc123XYZsecretid';

function fakeMm({ status = 200, body = 'ok', headers = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, o) => {
    calls.push({ url, ...o });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers } });
  };
  return { calls, fetchImpl };
}

test('https の /hooks/<id> の Webhook の URL だけを受け付ける(ホストは自由)', () => {
  const ok = (u, extra = {}) => new Mattermost({ env: { MATTERMOST_WEBHOOK_URL: u, ...extra } }).status().configured;
  assert.equal(ok(HOOK), true);
  assert.equal(ok('https://mm.corp.example:8065/team/hooks/abc123'), true); // サブパス
  assert.equal(ok('https://chat.example.com/api/v4/posts'), false);
  assert.equal(ok('https://chat.example.com/hooks/'), false);
  assert.equal(ok('https://chat.example.com/hooks/a/b'), false);
  assert.equal(ok('https://chat.example.com/hooks/a-b'), false);
  assert.equal(ok('http://chat.example.com/hooks/abc'), false);
  assert.equal(ok('not a url'), false);
  assert.equal(ok('http://127.0.0.1:9/hooks/abc', { WORKLOG_MATTERMOST_WEBHOOK_ANY: '1' }), true); // テスト用
  assert.deepEqual(new Mattermost({ env: { MATTERMOST_WEBHOOK_URL: HOOK } }).status(), { configured: true, mode: 'webhook', destination: 'Webhook', includeCost: false, notify: null });
});

test('送信: { text } を POST し(表示名とアイコンは設定から)、エラーと制限を伝える', async () => {
  const f = fakeMm();
  const m = new Mattermost({ env: { MATTERMOST_WEBHOOK_URL: HOOK }, fetchImpl: f.fetchImpl });
  assert.deepEqual(await m.post({ text: 'こんにちは' }), { url: null });
  assert.equal(f.calls[0].url, HOOK);
  assert.equal(f.calls[0].redirect, 'error');
  assert.deepEqual(JSON.parse(f.calls[0].body), { text: 'こんにちは' });
  m.setConfig({ username: 'Work Log', iconUrl: 'https://x.example/i.png' });
  await m.post({ text: 'a' });
  assert.deepEqual(JSON.parse(f.calls[1].body), { text: 'a', username: 'Work Log', icon_url: 'https://x.example/i.png' });
  m.setConfig({ iconUrl: 'javascript:alert(1)' });
  await m.post({ text: 'a' });
  assert.deepEqual(JSON.parse(f.calls[2].body), { text: 'a' });
  const err = (o) => new Mattermost({ env: { MATTERMOST_WEBHOOK_URL: HOOK }, fetchImpl: fakeMm(o).fetchImpl }).post({ text: 'x' });
  await assert.rejects(err({ status: 429, body: {}, headers: { 'retry-after': '2' } }), /2秒後/);
  await assert.rejects(err({ status: 400, body: { id: 'x', message: 'Unable to parse incoming data' } }), /Mattermost Webhook 400: Unable to parse incoming data/);
  await assert.rejects(new Mattermost({ env: {} }).post({ text: 'x' }), /MATTERMOST_WEBHOOK_URL/);
});

test('Markdown: 記号を逃がし、メンションを止め、タスクはリンクにする', () => {
  const r = buildReport({
    sessions: [one(1, '@channel @all @here @taro *太字* _x_ `z` [a](b) <b> # a|b')],
    tasks: [{ id: 'WEB-1', label: 'WEB-1', url: 'https://x.example/browse/WEB-1?a=(b)', issue: { title: 'A_B', stateLabel: 'Done' }, sessions: [{ id: 's1' }] }],
    costs: { buckets: [{ usd: 2 }] },
    range,
  });
  const m = toMattermost(r, { includeCost: true });
  assert.ok(m.text.startsWith('### Work Log 日報 2026/10/4(日)\n\n作業 20分・1セッション・0コミット・API換算 $2.00(参考値)\n\n#### プロジェクト別\n- web  20分(1セッション・0コミット)'), m.text);
  assert.ok(m.text.includes('＠channel ＠all ＠here ＠taro \\*太字\\* \\_x\\_ \\`z\\` \\[a\\](b) \\<b\\> \\# a\\|b'), m.text);
  assert.doesNotMatch(m.text, /@/);
  assert.ok(m.text.includes('- [WEB-1](https://x.example/browse/WEB-1?a=%28b%29) A\\_B(Done)  20分'), m.text);
  assert.equal(m.preview, m.text);
  assert.doesNotMatch(toMattermost(r).text, /\$/);
  assert.equal(plainFromMattermost('### 見出し\n\n- [WEB-1](https://a) A\\_B\n*フッター*'), '見出し\n\n- WEB-1 (https://a) A_B\nフッター');
});

test('Markdown: 16383 文字の上限に収める', () => {
  const many = Array.from({ length: 800 }, (_, i) => one(i, 'とても長いセッションのタイトル'.repeat(8)));
  const m = toMattermost(buildReport({ sessions: many, range }), { maxSessions: 800 });
  assert.ok([...m.text].length <= 16383);
  assert.match(m.text, /ほか \d+ セッション/);
});

test('セッション終了の通知(Mattermost)', () => {
  const m = sessionEndMattermost({ displayTitle: 'ログイン修正 @all', project: 'web', activeMs: 25 * 60000, commits: 1, tasks: [{ label: '#12', url: 'https://github.com/a/b/issues/12' }, { label: 'X', url: 'javascript:alert(1)' }] });
  assert.deepEqual(m, { text: '**セッション終了: ログイン修正 ＠all**\nweb・25分・1コミット\nタスク: [\\#12](https://github.com/a/b/issues/12), X' });
});

let last;
storeTests('mattermost', {
  make: () => {
    const f = fakeMm();
    last = f;
    return { client: new Mattermost({ env: { MATTERMOST_WEBHOOK_URL: HOOK }, fetchImpl: f.fetchImpl }), sent: () => f.calls.map((c) => c.body) };
  },
  secret: 'abc123XYZsecretid',
  sentText: () => last.calls.map((c) => JSON.parse(c.body).text).join('\n'),
  endPattern: /^\*\*セッション終了: \\\[GITHUB\\_TOKEN\\\] を使う修正\*\*/,
});
