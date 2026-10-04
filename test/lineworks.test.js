import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LineWorks } from '../src/lineworks.js';
import { buildReport, toLineWorks, sessionEndLineWorks } from '../src/report.js';
import { range, one, storeTests } from './dest-helpers.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ENV = {
  LINEWORKS_CLIENT_ID: 'CLIENTID', LINEWORKS_CLIENT_SECRET: 'CLIENTSECRET', LINEWORKS_SERVICE_ACCOUNT: 'abc.serviceaccount@example',
  LINEWORKS_PRIVATE_KEY: privateKey, LINEWORKS_BOT_ID: '777', LINEWORKS_CHANNEL_ID: 'ch/1',
};

// 認証(JWT の署名を検証する)と送信を受ける偽のサーバー。呼び出しは calls に残る
function fakeLw({ tokenStatus = 200, sendStatus = 200, sendBody = {}, headers = {}, expiresIn = 86400, onToken } = {}) {
  const calls = [];
  const state = { sendStatus, tokens: 0 };
  const fetchImpl = async (url, o) => {
    const u = new URL(url);
    if (u.hostname === 'auth.worksmobile.com') {
      state.tokens++;
      const form = new URLSearchParams(o.body);
      calls.push({ kind: 'token', url, form, method: o.method, headers: o.headers });
      onToken?.(form);
      return new Response(JSON.stringify(tokenStatus === 200 ? { access_token: `AT${state.tokens}`, expires_in: expiresIn, token_type: 'Bearer', scope: 'bot' } : { error: 'invalid_grant', error_description: 'bad assertion' }), { status: tokenStatus });
    }
    calls.push({ kind: 'send', url, ...o });
    return new Response(JSON.stringify(sendBody), { status: state.sendStatus, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { calls, state, fetchImpl };
}

test('設定: 必要な値がそろったときだけ設定済みになる(送り先のチャンネルは config.json でもよい)', () => {
  const st = (env, cfg) => new LineWorks({ env, config: cfg }).status();
  assert.deepEqual(st(ENV), { configured: true, mode: 'bot', destination: 'Bot', includeCost: false, notify: null });
  const { LINEWORKS_CHANNEL_ID, ...noChannel } = ENV;
  assert.equal(st(noChannel).configured, false);
  assert.equal(st(noChannel, { channelId: 'c2' }).configured, true);
  const { LINEWORKS_PRIVATE_KEY, ...noKey } = ENV;
  assert.equal(st(noKey).configured, false);
  assert.equal(st({ ...noKey, LINEWORKS_PRIVATE_KEY_FILE: '/x/key.pem' }).configured, true);
  assert.equal(st({ ...ENV, LINEWORKS_BOT_ID: '' }).configured, false);
});

test('送信: JWT(RS256)をサービスアカウントの鍵で署名してトークンに換え、Bearer で送る。トークンは使い回す', async () => {
  const f = fakeLw();
  let now = Date.parse('2026-10-04T00:00:00Z');
  const c = new LineWorks({ env: ENV, fetchImpl: f.fetchImpl, now: () => now });
  assert.deepEqual(await c.post({ messages: ['こんにちは', '2通目'] }), { url: null });
  const [tok, a, b] = f.calls;
  assert.equal(tok.url, 'https://auth.worksmobile.com/oauth2/v2.0/token');
  assert.equal(tok.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(tok.form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(tok.form.get('client_id'), 'CLIENTID');
  assert.equal(tok.form.get('client_secret'), 'CLIENTSECRET');
  assert.equal(tok.form.get('scope'), 'bot');
  const [h, p, sig] = tok.form.get('assertion').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.deepEqual(claims, { iss: 'CLIENTID', sub: 'abc.serviceaccount@example', iat: now / 1000, exp: now / 1000 + 3600 });
  assert.equal(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url')), true);
  assert.equal(createVerify('RSA-SHA256').update(`${h}.${p}x`).verify(publicKey, Buffer.from(sig, 'base64url')), false);
  assert.equal(a.url, 'https://www.worksapis.com/v1.0/bots/777/channels/ch%2F1/messages');
  assert.equal(a.redirect, 'error');
  assert.equal(a.headers.authorization, 'Bearer AT1');
  assert.deepEqual(JSON.parse(a.body), { content: { type: 'text', text: 'こんにちは' } });
  assert.deepEqual(JSON.parse(b.body), { content: { type: 'text', text: '2通目' } });
  assert.equal(f.state.tokens, 1);
  // 期限の前は使い回し、期限が近づいたら取り直す
  now += 3600 * 1000;
  await c.post({ messages: ['x'] });
  assert.equal(f.state.tokens, 1);
  now += 24 * 3600 * 1000;
  await c.post({ messages: ['x'] });
  assert.equal(f.state.tokens, 2);
  assert.equal(f.calls.at(-1).headers.authorization, 'Bearer AT2');
});

test('送信: 鍵はファイルや \\n 区切りの環境変数からも読める。読めなければ分かる文言で止める', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'work-log-lw-'));
  try {
    const file = path.join(dir, 'private.key');
    await writeFile(file, privateKey);
    const { LINEWORKS_PRIVATE_KEY, ...rest } = ENV;
    const f = fakeLw();
    await new LineWorks({ env: { ...rest, LINEWORKS_PRIVATE_KEY_FILE: file }, fetchImpl: f.fetchImpl }).post({ messages: ['a'] });
    assert.equal(f.calls.at(-1).headers.authorization, 'Bearer AT1');
    const g = fakeLw();
    await new LineWorks({ env: { ...rest, LINEWORKS_PRIVATE_KEY: privateKey.trim().replace(/\n/g, '\\n') }, fetchImpl: g.fetchImpl }).post({ messages: ['a'] });
    await assert.rejects(new LineWorks({ env: { ...rest, LINEWORKS_PRIVATE_KEY_FILE: path.join(dir, 'none') }, fetchImpl: fakeLw().fetchImpl }).post({ messages: ['a'] }), /ファイルがありません/);
    await assert.rejects(new LineWorks({ env: { ...ENV, LINEWORKS_PRIVATE_KEY: 'not a key' }, fetchImpl: fakeLw().fetchImpl }).post({ messages: ['a'] }), /秘密鍵を読めません/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('送信: 認証の失敗・429・API のエラーを伝え、失効(401)は取り直して1回だけやり直す', async () => {
  await assert.rejects(new LineWorks({ env: ENV, fetchImpl: fakeLw({ tokenStatus: 400 }).fetchImpl }).post({ messages: ['x'] }), /LINE WORKS の認証に失敗しました 400: bad assertion/);
  const err = (o) => new LineWorks({ env: ENV, fetchImpl: fakeLw(o).fetchImpl }).post({ messages: ['x'] });
  await assert.rejects(err({ sendStatus: 429, headers: { 'retry-after': '2' } }), /2秒後/);
  await assert.rejects(err({ sendStatus: 403, sendBody: { code: 'FORBIDDEN', description: 'Bot is not a member' } }), /LINE WORKS Bot API 403: Bot is not a member/);
  await assert.rejects(new LineWorks({ env: {} }).post({ messages: ['x'] }), /LINEWORKS_CLIENT_ID/);
  const f = fakeLw({ sendStatus: 401 });
  await assert.rejects(new LineWorks({ env: ENV, fetchImpl: f.fetchImpl }).post({ messages: ['x'] }), /401/);
  assert.equal(f.state.tokens, 2); // 取り直して1回だけ
  assert.equal(f.calls.filter((x) => x.kind === 'send').length, 2);
  // 途中で失敗したら、あとのメッセージは送らない
  const g = fakeLw({ sendStatus: 500 });
  await assert.rejects(new LineWorks({ env: ENV, fetchImpl: g.fetchImpl }).post({ messages: ['1', '2'] }), /500/);
  assert.equal(g.calls.filter((x) => x.kind === 'send').length, 1);
});

test('テスト用に認証と API の場所を差し替えられる(実際の HTTP で確かめる)', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      res.end(req.url === '/token' ? JSON.stringify({ access_token: 'LOCALTOKEN', expires_in: 3600 }) : '{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  await new LineWorks({ env: { ...ENV, WORKLOG_LINEWORKS_AUTH: `${base}/token`, WORKLOG_LINEWORKS_API: `${base}/v1.0/` } }).post({ messages: ['hi'] });
  assert.deepEqual(seen.map((s) => s.url), ['/token', '/v1.0/bots/777/channels/ch%2F1/messages']);
  assert.equal(seen[1].auth, 'Bearer LOCALTOKEN');
  assert.deepEqual(JSON.parse(seen[1].body), { content: { type: 'text', text: 'hi' } });
});

test('テキスト: プレーンテキストで、リンクは URL を添える。コストは指定したときだけ', () => {
  const r = buildReport({
    sessions: [one(1, '*そのまま* <b> [x]')],
    tasks: [{ id: 'WEB-1', label: 'WEB-1', url: 'https://x.example/browse/WEB-1', issue: { title: 'A_B', stateLabel: 'Done' }, sessions: [{ id: 's1' }] }],
    costs: { buckets: [{ usd: 2 }] },
    range,
  });
  const m = toLineWorks(r, { includeCost: true });
  assert.equal(m.messages.length, 1);
  assert.equal(m.messages[0], [
    'Work Log 日報 2026/10/4(日)\n作業 20分・1セッション・0コミット・API 換算 $2.00',
    '■ プロジェクト別\n・web  20分(1セッション・0コミット)',
    '■ タスク\n・WEB-1 (https://x.example/browse/WEB-1) A_B(Done)  20分',
    '■ セッション\n・01:00 *そのまま* <b> [x] — web・20分',
  ].join('\n\n'));
  assert.equal(m.preview, m.messages[0]);
  assert.doesNotMatch(toLineWorks(r).messages[0], /\$/);
});

test('テキスト: 2000 文字ごとに複数のメッセージに分け、5通に収める', () => {
  const some = Array.from({ length: 60 }, (_, i) => one(i, 'とても長いセッションのタイトル'.repeat(4)));
  const m = toLineWorks(buildReport({ sessions: some, range }), { maxSessions: 60 });
  assert.ok(m.messages.length > 1 && m.messages.length <= 5, String(m.messages.length));
  for (const x of m.messages) assert.ok([...x].length <= 2000);
  assert.equal(m.messages.join('\n').match(/・01:00/g).length, 60); // 収まる分は削らない
  const many = Array.from({ length: 400 }, (_, i) => one(i, 'とても長いセッションのタイトル'.repeat(8)));
  const n = toLineWorks(buildReport({ sessions: many, range }), { maxSessions: 400 });
  assert.ok(n.messages.length <= 5);
  for (const x of n.messages) assert.ok([...x].length <= 2000);
  assert.match(n.messages.at(-1), /ほか \d+ セッション$/);
});

test('セッション終了の通知(LINE WORKS)', () => {
  const m = sessionEndLineWorks({ displayTitle: 'ログイン修正', project: 'web', activeMs: 25 * 60000, commits: 1, tasks: [{ label: '#12', url: 'https://github.com/a/b/issues/12' }, { label: 'X', url: 'javascript:alert(1)' }] });
  assert.deepEqual(m, { messages: ['セッション終了: ログイン修正\nweb・25分・1コミット\nタスク: #12 (https://github.com/a/b/issues/12), X'] });
  assert.ok([...sessionEndLineWorks({ displayTitle: 'あ'.repeat(5000), project: 'web', activeMs: 0, commits: 0 }).messages[0]].length <= 2000);
});

let last;
storeTests('lineworks', {
  make: () => {
    const f = fakeLw();
    last = f;
    return { client: new LineWorks({ env: ENV, fetchImpl: f.fetchImpl }), sent: () => f.calls.filter((c) => c.kind === 'send').map((c) => c.body) };
  },
  secret: 'CLIENTSECRET',
  sentText: () => last.calls.filter((c) => c.kind === 'send').map((c) => JSON.parse(c.body).content.text).join('\n'),
  endPattern: /^セッション終了: \[GITHUB_TOKEN\] を使う修正/,
});
