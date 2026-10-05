import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CalDav } from '../src/sync/caldav.js';
import { buildEvent } from '../src/ical.js';

// CalDAV サーバーを真似る(実際の Radicale 3.8.1 で確かめた振る舞い: PUT の応答に ETag、条件が合わなければ 412、
// 無いコレクションへの PUT は 409、無いものへの If-Match も 412、認証に失敗したら 401)
async function fakeDav(t, { user = 'wl', pass = 'päss' } = {}) {
  const items = new Map(); // path -> { body, etag }
  const log = [];
  let n = 0;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    log.push({ method: req.method, url: req.url, headers: req.headers, body });
    const auth = req.headers.authorization || '';
    if (auth !== `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`) return res.writeHead(401, { 'www-authenticate': 'Basic realm="x"' }).end('Access to the requested resource forbidden.');
    if (!req.url.startsWith('/dav/cal/')) return res.writeHead(409).end('<?xml version="1.0"?><error/>');
    const cur = items.get(req.url);
    if (req.method === 'GET') return cur ? res.writeHead(200, { etag: cur.etag, 'content-type': 'text/calendar' }).end(cur.body) : res.writeHead(404).end();
    const im = req.headers['if-match'];
    if ((req.headers['if-none-match'] === '*' && cur) || (im && im !== cur?.etag)) return res.writeHead(412).end();
    if (req.method === 'DELETE') {
      if (!cur) return res.writeHead(404).end();
      items.delete(req.url);
      return res.writeHead(200).end();
    }
    if (req.method === 'PUT') {
      const etag = `"v${++n}"`;
      items.set(req.url, { body, etag });
      return res.writeHead(cur ? 204 : 201, { etag }).end();
    }
    res.writeHead(405).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  // 外から書き換える(カレンダーのアプリでの編集の代わり)
  const touch = (path) => items.set(path, { ...items.get(path), etag: `"x${++n}"` });
  return { base, items, log, touch };
}

const entry = (o = {}) => ({ key: 'sess-1-0', title: '修正; "引用", 改行\nあり', description: 'プロジェクト: web\n(Work Log で記録)', project: 'web', start: '2026-10-05T01:00:00.000Z', end: '2026-10-05T01:30:00.000Z', ...o });

function client(base, env = {}) {
  return new CalDav({ env: { CALDAV_URL: `${base}/dav/cal`, CALDAV_USERNAME: 'wl', CALDAV_PASSWORD: 'päss', ...env } });
}

test('CalDAV: 追加は If-None-Match: *、更新・削除は If-Match: <ETag>、ETag を返す', async (t) => {
  const dav = await fakeDav(t);
  const c = client(dav.base);
  assert.equal(c.status().configured, true);
  assert.equal(c.status().destination, `${new URL(dav.base).host} /dav/cal/`);
  const r = await c.create(entry());
  assert.deepEqual(r, { id: 'sess-1-0.ics', etag: '"v1"' });
  const put = dav.log[0];
  assert.equal(`${put.method} ${put.url}`, 'PUT /dav/cal/sess-1-0.ics');
  assert.equal(put.headers['if-none-match'], '*');
  assert.equal(put.headers['content-type'], 'text/calendar; charset=utf-8');
  assert.equal(put.headers.authorization, `Basic ${Buffer.from('wl:päss').toString('base64')}`);
  assert.match(put.body, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\n/);
  assert.doesNotMatch(put.body, /METHOD:/); // CalDAV のカレンダーには METHOD を書かない
  assert.match(put.body, /\r\nUID:sess-1-0@work-log\r\n/);
  assert.match(put.body, /\r\nSUMMARY:修正\\; "引用"\\, 改行\\nあり\r\n/);
  assert.equal((put.body.match(/BEGIN:VEVENT/g) || []).length, 1);

  const u = await c.update(r.id, entry({ title: '新しい' }), { etag: r.etag });
  assert.deepEqual(u, { id: 'sess-1-0.ics', etag: '"v2"' });
  assert.equal(dav.log[1].headers['if-match'], '"v1"');
  assert.match(dav.items.get('/dav/cal/sess-1-0.ics').body, /SUMMARY:新しい/);

  await c.remove(u.id, { etag: u.etag });
  assert.equal(dav.log[2].method, 'DELETE');
  assert.equal(dav.log[2].headers['if-match'], '"v2"');
  assert.equal(dav.items.size, 0);
  // 既に無いものの削除は 404(sync/index.js が「消えたことにする」)
  await assert.rejects(c.remove('sess-1-0.ics'), (err) => err.status === 404);
});

test('CalDAV: 412 のときは今の ETag を取り直して上書き・作り直し・削除する', async (t) => {
  const dav = await fakeDav(t);
  const c = client(dav.base);
  const r = await c.create(entry());
  // カレンダー側で書き換えられた → 更新は上書きする
  dav.touch('/dav/cal/sess-1-0.ics');
  dav.log.length = 0;
  const u = await c.update(r.id, entry({ title: '上書き' }), { etag: r.etag });
  assert.deepEqual(dav.log.map((x) => `${x.method} ${x.headers['if-match'] || x.headers['if-none-match'] || ''}`), [`PUT ${r.etag}`, 'GET ', 'PUT "x2"']);
  assert.match(dav.items.get('/dav/cal/sess-1-0.ics').body, /SUMMARY:上書き/);
  // カレンダー側で消された → 更新は作り直す
  dav.items.clear();
  dav.log.length = 0;
  await c.update(u.id, entry(), { etag: u.etag });
  assert.deepEqual(dav.log.map((x) => x.method), ['PUT', 'GET', 'PUT']);
  assert.equal(dav.log[2].headers['if-none-match'], '*');
  assert.equal(dav.items.size, 1);
  // 対応表が無くなって同じ名前で追加 → 重複させずに上書き
  dav.log.length = 0;
  const again = await c.create(entry({ title: '再追加' }));
  assert.equal(again.id, 'sess-1-0.ics');
  assert.deepEqual(dav.log.map((x) => x.method), ['PUT', 'GET', 'PUT']);
  assert.equal(dav.items.size, 1);
  // 削除の 412 → 取り直して削除
  dav.touch('/dav/cal/sess-1-0.ics');
  await c.remove(again.id, { etag: again.etag });
  assert.equal(dav.items.size, 0);
  // ETag の無い更新は条件なしで送る
  dav.log.length = 0;
  await c.update('sess-1-0.ics', entry());
  assert.equal(dav.log[0].headers['if-match'], undefined);
});

test('CalDAV: 何度取り直しても 412 なら止めて伝える', async () => {
  const c = new CalDav({
    env: { CALDAV_URL: 'https://dav.example/cal/', CALDAV_USERNAME: 'u', CALDAV_PASSWORD: 'p' },
    fetchImpl: async (url, o) => new Response(null, { status: o.method === 'GET' ? 200 : 412, headers: { etag: '"z"' } }),
  });
  await assert.rejects(c.update('k.ics', entry(), { etag: '"a"' }), (err) => err.status === 409 && /同時に書き換えられています/.test(err.message));
});

test('CalDAV: 401・409 は原因を伝える', async (t) => {
  const dav = await fakeDav(t);
  await assert.rejects(client(dav.base, { CALDAV_PASSWORD: 'wrong' }).create(entry()), (err) => err.status === 401 && /認証に失敗しました/.test(err.message));
  await assert.rejects(client(dav.base, { CALDAV_URL: `${dav.base}/dav/nope/` }).create(entry()), (err) => err.status === 409 && /カレンダー\(コレクション\)が見つかりません/.test(err.message));
});

test('CalDAV: https だけ(localhost は http も可)。URL の中の認証情報は使わない', () => {
  const st = (url, extra = {}) => new CalDav({ env: { CALDAV_URL: url, CALDAV_USERNAME: 'u', CALDAV_PASSWORD: 'p', ...extra } }).status();
  assert.equal(st('https://caldav.fastmail.com/dav/calendars/user/me@example.com/abc/').configured, true);
  assert.equal(st('https://caldav.fastmail.com/dav/calendars/user/me@example.com/abc/').destination, 'caldav.fastmail.com /dav/calendars/user/[EMAIL]/abc/');
  assert.equal(st('http://localhost:5232/u/cal/').configured, true);
  assert.equal(st('http://127.0.0.1:5232/u/cal').configured, true);
  assert.equal(st('http://[::1]:5232/u/cal').configured, true);
  for (const bad of ['http://dav.example/cal/', 'https://u:p@dav.example/cal/', 'ftp://dav.example/', 'not a url', 'https://dav.example/cal/?x=1']) {
    const s = st(bad);
    assert.equal(s.configured, false, bad);
    assert.match(s.missing.join(' '), /https の URL/);
  }
  assert.deepEqual(new CalDav({ env: {} }).status().missing, ['CALDAV_URL(または config.json の caldav.url)', 'CALDAV_USERNAME', 'CALDAV_PASSWORD']);
  // config.json の caldav.url / caldav.username でもよい(パスワードは環境変数だけ)
  const c = new CalDav({ env: { CALDAV_PASSWORD: 'p' } });
  c.setConfig({ url: 'https://dav.example/cal', username: 'u' });
  assert.equal(c.collection(), 'https://dav.example/cal/');
  assert.equal(c.status().configured, true);
});

test('CalDAV: 対応表の ID はコレクションの中の名前だけ(パスを含むものは送らない)', async () => {
  const calls = [];
  const c = new CalDav({ env: { CALDAV_URL: 'https://dav.example/cal/', CALDAV_USERNAME: 'u', CALDAV_PASSWORD: 'p' }, fetchImpl: async (url) => (calls.push(url), new Response(null, { status: 204 })) });
  assert.equal(c.nameOf('a/b c'), 'a%2Fb%20c.ics');
  await assert.rejects(c.remove('../other/x.ics'), /名前が不正/);
  await assert.rejects(c.update('https://evil.example/x.ics', entry()), /名前が不正/);
  assert.equal(calls.length, 0);
  // hash を取る内容は送るたびに変わる DTSTAMP を含まない
  assert.deepEqual(c.payload(entry()), c.payload(entry()));
  assert.equal(buildEvent(entry(), { now: 0 }).includes('DTSTAMP:19700101T000000Z'), true);
});
