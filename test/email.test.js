import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { Email, buildMessage, encodeWord, dotStuff, rfc5322Date } from '../src/email.js';
import { buildReport, toEmail, sessionEndEmail, plainFromEmail } from '../src/report.js';
import { range, one, storeTests } from './dest-helpers.js';

const fx = (f) => readFileSync(new URL(`./fixtures/smtp-tls/${f}`, import.meta.url), 'utf8');
const CA = fx('ca.crt');
const KEY = fx('server.key');
const CERT = fx('server.crt');

// 偽の SMTP サーバー。opts: { starttls, implicitTls, auth: ['PLAIN', 'LOGIN'], noEhlo, rejectRcpt: [addr], silent }
function fakeSmtp(opts = {}) {
  const log = { cmds: [], messages: [], auth: [], tls: [] };
  const handle = (socket, secure) => {
    let buf = '';
    let mode = 'cmd';
    let data = [];
    let cur = { from: null, rcpt: [] };
    let login = null;
    const send = (s) => socket.write(`${s}\r\n`);
    const ehloLines = () => ['fake.example', 'PIPELINING', ...(opts.starttls && !secure ? ['STARTTLS'] : []), ...(opts.auth?.length ? [`AUTH ${opts.auth.join(' ')}`] : []), 'SIZE 10240000'];
    const line = (l) => {
      if (mode === 'data') {
        if (l === '.') {
          mode = 'cmd';
          log.messages.push({ ...cur, data: data.join('\r\n'), secure });
          cur = { from: null, rcpt: [] };
          return send('250 2.0.0 Ok: queued as ABC123');
        }
        data.push(l.startsWith('..') ? l.slice(1) : l);
        log.rawData.push(l);
        return;
      }
      if (login) {
        login.push(Buffer.from(l, 'base64').toString());
        if (login.length === 1) return send('334 UGFzc3dvcmQ6');
        log.auth.push({ mech: 'LOGIN', user: login[0], pass: login[1] });
        login = null;
        return send('235 2.7.0 Authentication successful');
      }
      log.cmds.push(l);
      const [verb, ...rest] = l.split(' ');
      const arg = rest.join(' ');
      switch (verb.toUpperCase()) {
        case 'EHLO':
          if (opts.noEhlo) return send('502 5.5.2 Error: command not recognized');
          return send(ehloLines().map((x, i, a) => `250${i === a.length - 1 ? ' ' : '-'}${x}`).join('\r\n'));
        case 'HELO':
          return send('250 fake.example');
        case 'STARTTLS': {
          send('220 2.0.0 Ready to start TLS');
          socket.removeAllListeners('data');
          const t = new tls.TLSSocket(socket, { isServer: true, key: KEY, cert: CERT });
          t.on('error', () => {});
          log.tls.push('starttls');
          return handle2(t);
        }
        case 'AUTH': {
          const [mech, initial] = arg.split(' ');
          if (mech === 'PLAIN') {
            const [, user, pass] = Buffer.from(initial, 'base64').toString().split('\0');
            log.auth.push({ mech, user, pass });
            return send(user === 'bad' ? '535 5.7.8 Error: authentication failed' : '235 2.7.0 Authentication successful');
          }
          login = [];
          return send('334 VXNlcm5hbWU6');
        }
        case 'MAIL':
          cur.from = /<(.*)>/.exec(arg)[1];
          return send('250 2.1.0 Ok');
        case 'RCPT': {
          const a = /<(.*)>/.exec(arg)[1];
          if ((opts.rejectRcpt || []).includes(a)) return send('550 5.1.1 <' + a + '>: Recipient address rejected');
          cur.rcpt.push(a);
          return send('250 2.1.5 Ok');
        }
        case 'DATA':
          mode = 'data';
          data = [];
          return send('354 End data with <CR><LF>.<CR><LF>');
        case 'QUIT':
          send('221 2.0.0 Bye');
          return socket.end();
        default:
          return send('502 5.5.2 Error: command not recognized');
      }
    };
    // STARTTLS の後は TLS のソケットで続きを読む(状態は引き継がず、EHLO からやり直す)
    const handle2 = (t) => {
      secure = true;
      buf = '';
      t.on('data', onData);
      socket = t;
    };
    const onData = (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 2);
        line(l);
        if (socket.destroyed) return;
      }
    };
    socket.on('data', onData);
    socket.on('error', () => {});
    if (!opts.silent) send('220-fake.example ESMTP\r\n220 ready');
  };
  log.rawData = [];
  const server = opts.implicitTls ? tls.createServer({ key: KEY, cert: CERT }, (s) => handle(s, true)) : net.createServer((s) => handle(s, false));
  return {
    log,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => {
      server.close(r);
      server.closeAllConnections?.();
    }),
    server,
  };
}

async function withServer(t, opts) {
  const f = fakeSmtp(opts);
  const port = await f.listen();
  t.after(() => f.close());
  return { ...f, port };
}

const ENV = (port, extra = {}) => ({ SMTP_URL: `smtp://user%40x:p%3Ass@localhost:${port}`, MAIL_FROM: 'worklog@example.com', MAIL_TO: 'a@example.com, b@example.org', ...extra });
const MSG = { subject: 'Work Log 日報 2026/10/4(日)', text: 'こんにちは\n.ドットで始まる行\n', html: '<p>こんにちは</p>' };

// 受け取ったメッセージをヘッダーと各パートに分ける
function parse(data) {
  const [head, ...rest] = data.split('\r\n\r\n');
  const headers = head.replace(/\r\n[ \t]+/g, ' ').split('\r\n');
  const boundary = /boundary="([^"]+)"/.exec(head)[1];
  const parts = rest.join('\r\n\r\n').split(`--${boundary}`).slice(1, -1).map((p) => {
    const [ph, pb] = p.replace(/^\r\n/, '').split('\r\n\r\n');
    return { headers: ph, body: Buffer.from(pb.replace(/\s+/g, ''), 'base64').toString('utf8') };
  });
  return { headers, parts, header: (n) => headers.find((h) => h.toLowerCase().startsWith(`${n.toLowerCase()}:`))?.slice(n.length + 1).trim() };
}
const decodeWords = (v) => v.replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));

test('設定: SMTP_URL・差出人・宛先がそろったときだけ使え、status() に認証情報と宛先を出さない', () => {
  const st = (env, config) => new Email({ env, config }).status();
  assert.deepEqual(st(ENV(587)), { configured: true, mode: 'smtp', destination: 'localhost:587', includeCost: false, notify: null });
  assert.equal(JSON.stringify(st(ENV(587))).includes('p:ss'), false);
  assert.equal(JSON.stringify(st(ENV(587))).includes('a@example.com'), false);
  assert.equal(st({ ...ENV(587), SMTP_URL: 'smtps://u:p@mail.example.com' }).mode, 'smtps');
  assert.equal(st({ ...ENV(587), SMTP_URL: 'smtps://u:p@mail.example.com' }).destination, 'mail.example.com:465');
  assert.equal(st({ ...ENV(587), SMTP_URL: 'smtp://mail.example.com' }).destination, 'mail.example.com:587');
  assert.equal(st({ ...ENV(587), SMTP_URL: 'smtp://mail.example.com:465' }).mode, 'smtps');
  assert.equal(st({ ...ENV(587), WORKLOG_SMTP_SECURE: '1' }).mode, 'smtps');
  assert.equal(st({ ...ENV(587), SMTP_URL: 'http://mail.example.com' }).configured, false);
  assert.equal(st({ ...ENV(587), SMTP_URL: 'smtp://mail.example.com/x' }).configured, false);
  assert.equal(st({ ...ENV(587), SMTP_URL: 'nope' }).configured, false);
  assert.equal(st({ ...ENV(587), MAIL_FROM: '' }).configured, false);
  assert.equal(st({ ...ENV(587), MAIL_FROM: 'a@b.example\r\nBcc: x@y.example' }).configured, false);
  assert.equal(st({ ...ENV(587), MAIL_TO: 'a@example.com, <x>' }).configured, false);
  assert.equal(st({ ...ENV(587), MAIL_TO: '' }).configured, false);
  assert.equal(st({ ...ENV(587), MAIL_TO: '' }, { to: ['x@example.com'], from: 'me@example.com', notify: 'session_end', includeCost: true }).notify, 'session_end');
  assert.equal(st({ SMTP_URL: 'smtp://h.example' }, { to: 'x@example.com,y@example.com', from: 'me@example.com' }).configured, true);
});

test('メッセージ: ヘッダー(Date / Message-ID / From / To / Subject / MIME)と text・html の2つのパート', () => {
  const m = buildMessage({ from: 'worklog@example.com', to: ['a@example.com', 'b@example.org'], ...MSG, now: Date.UTC(2026, 9, 4, 9, 5, 7), id: 'abc' });
  const p = parse(m);
  assert.equal(p.header('Date'), 'Sun, 04 Oct 2026 09:05:07 +0000');
  assert.equal(p.header('Message-ID'), `<abc.${Date.UTC(2026, 9, 4, 9, 5, 7)}@example.com>`);
  assert.equal(p.header('From'), 'Work Log <worklog@example.com>');
  assert.equal(p.header('To'), 'a@example.com, b@example.org');
  assert.equal(p.header('MIME-Version'), '1.0');
  assert.match(p.header('Subject'), /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  assert.equal(decodeWords(p.header('Subject')), MSG.subject);
  assert.match(p.header('Content-Type'), /^multipart\/alternative; boundary="=_worklog_abc"$/);
  assert.equal(p.parts.length, 2);
  assert.match(p.parts[0].headers, /Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64/);
  assert.match(p.parts[1].headers, /Content-Type: text\/html; charset=UTF-8/);
  assert.equal(p.parts[0].body, MSG.text.replace(/\n/g, '\r\n')); // 改行は CRLF にそろえてから符号化する
  assert.equal(p.parts[1].body, MSG.html);
  for (const l of m.split('\r\n')) assert.ok(l.length <= 78, l); // 1行 78 文字まで
  assert.doesNotMatch(m, /[^\r]\n/); // 改行はすべて CRLF
  assert.equal(rfc5322Date(Date.UTC(2026, 0, 1, 0, 0, 0)), 'Thu, 01 Jan 2026 00:00:00 +0000');
});

test('件名: 長い日本語は文字の途中で切らずに 75 文字以内の語に分け、改行は空白にする(ヘッダーの差し込みを防ぐ)', () => {
  const long = 'とても長い件名の日報です🎉'.repeat(8);
  const enc = encodeWord(long);
  for (const w of enc.split('\r\n ')) assert.ok(w.length <= 75, w);
  assert.equal(decodeWords(enc.replace(/\r\n /g, ' ')), long);
  const inj = encodeWord('a\r\nBcc: evil@example.net\nX-Injected: 1');
  assert.doesNotMatch(inj, /\r\n(?! )/);
  assert.equal(decodeWords(inj.replace(/\r\n /g, ' ')), 'a Bcc: evil@example.net X-Injected: 1');
  const m = buildMessage({ from: 'w@example.com', to: ['a@example.com'], subject: 'x\r\nBcc: evil@example.net', text: 'a', html: 'b' });
  assert.doesNotMatch(m.split('\r\n\r\n')[0], /^Bcc:/im);
  assert.equal(encodeWord(''), '=?UTF-8?B??=');
});

test('DATA: 改行を CRLF にし、行頭の . を .. にして <CRLF>.<CRLF> で終える', () => {
  assert.equal(dotStuff('a\n.b\r\n..c\n.'), 'a\r\n..b\r\n...c\r\n..\r\n.\r\n');
  assert.equal(dotStuff('a\r\n'), 'a\r\n.\r\n');
});

test('送信: STARTTLS(証明書を確かめる)→ AUTH PLAIN → 複数の宛先 → DATA → QUIT', async (t) => {
  const s = await withServer(t, { starttls: true, auth: ['LOGIN', 'PLAIN'] });
  const e = new Email({ env: ENV(s.port), ca: CA, config: { subjectPrefix: '[WL]\r\n ' } });
  const r = await e.post(MSG);
  assert.equal(r.url, null);
  assert.match(r.response, /queued as ABC123/);
  assert.deepEqual(s.log.tls, ['starttls']);
  assert.deepEqual(s.log.auth, [{ mech: 'PLAIN', user: 'user@x', pass: 'p:ss' }]);
  const verbs = s.log.cmds.map((c) => c.split(' ')[0]);
  assert.deepEqual(verbs, ['EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'MAIL', 'RCPT', 'RCPT', 'DATA', 'QUIT']);
  const msg = s.log.messages[0];
  assert.equal(msg.secure, true);
  assert.equal(msg.from, 'worklog@example.com');
  assert.deepEqual(msg.rcpt, ['a@example.com', 'b@example.org']);
  const p = parse(msg.data);
  assert.equal(decodeWords(p.header('Subject')), `[WL]  ${MSG.subject}`);
  assert.equal(p.parts[0].body, MSG.text.replace(/\n/g, '\r\n'));
  assert.equal(p.parts[1].body, MSG.html);
});

test('送信: 自己署名などで証明書を確かめられないときは送らない(WORKLOG_SMTP_INSECURE=1 のときだけ許す)', async (t) => {
  const s = await withServer(t, { starttls: true, auth: ['PLAIN'] });
  await assert.rejects(new Email({ env: ENV(s.port) }).post(MSG), /STARTTLS に失敗しました/);
  assert.equal(s.log.auth.length, 0);
  assert.equal(s.log.messages.length, 0);
  await new Email({ env: ENV(s.port, { WORKLOG_SMTP_INSECURE: '1' }) }).post(MSG);
  assert.equal(s.log.messages.length, 1);
});

test('送信: smtps:// は最初から TLS(STARTTLS は使わない)、AUTH LOGIN にも対応', async (t) => {
  const s = await withServer(t, { implicitTls: true, auth: ['LOGIN'] });
  await new Email({ env: ENV(s.port, { SMTP_URL: `smtps://me:pw@localhost:${s.port}` }), ca: CA }).post(MSG);
  assert.deepEqual(s.log.auth, [{ mech: 'LOGIN', user: 'me', pass: 'pw' }]);
  assert.deepEqual(s.log.tls, []);
  assert.equal(s.log.messages[0].secure, true);
  // WORKLOG_SMTP_SECURE=1 でも同じ
  await new Email({ env: ENV(s.port, { SMTP_URL: `smtp://localhost:${s.port}`, WORKLOG_SMTP_SECURE: '1' }), ca: CA }).post(MSG);
  assert.equal(s.log.messages.length, 2);
});

test('送信: TLS の無いサーバーには、手元(localhost)以外ではパスワードを送らない', async (t) => {
  const s = await withServer(t, { auth: ['PLAIN'] });
  // mail.internal.test は手元のサーバーの別名(名前解決だけ差し替える)
  const lookup = (host, opts, cb) => (opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));
  await assert.rejects(new Email({ env: ENV(s.port, { SMTP_URL: `smtp://u:p@mail.internal.test:${s.port}` }), lookup }).post(MSG), /パスワードを送りませんでした/);
  assert.equal(s.log.auth.length, 0);
  assert.equal(s.log.messages.length, 0);
  // 認証情報が無ければ送れる(社内の中継サーバーなど)
  await new Email({ env: ENV(s.port, { SMTP_URL: `smtp://mail.internal.test:${s.port}` }), lookup }).post(MSG);
  // localhost なら TLS が無くても認証する(手元のテスト用サーバー)
  await new Email({ env: ENV(s.port) }).post(MSG);
  assert.equal(s.log.messages.length, 2);
  assert.equal(s.log.auth.length, 1);
});

test('送信: EHLO を知らないサーバーには HELO、断られた宛先・認証の失敗・応答が無いときはエラー', async (t) => {
  const old = await withServer(t, { noEhlo: true });
  await new Email({ env: ENV(old.port, { SMTP_URL: `smtp://localhost:${old.port}` }) }).post(MSG);
  assert.deepEqual(old.log.cmds.map((c) => c.split(' ')[0]).slice(0, 2), ['EHLO', 'HELO']);

  const rej = await withServer(t, { rejectRcpt: ['b@example.org'] });
  await assert.rejects(new Email({ env: ENV(rej.port, { SMTP_URL: `smtp://localhost:${rej.port}` }) }).post(MSG), /SMTP RCPT TO: 550 5\.1\.1 <b@example\.org>/);
  assert.equal(rej.log.messages.length, 0); // 1人でも断られたら送らない

  const bad = await withServer(t, { auth: ['PLAIN'] });
  await assert.rejects(new Email({ env: ENV(bad.port, { SMTP_URL: `smtp://bad:secretpw@localhost:${bad.port}` }) }).post(MSG), (e) => /SMTP AUTH PLAIN: 535/.test(e.message) && !e.message.includes('secretpw'));

  const noauth = await withServer(t, {});
  await assert.rejects(new Email({ env: ENV(noauth.port) }).post(MSG), /PLAIN \/ LOGIN の認証に対応していません/);

  const silent = await withServer(t, { silent: true });
  await assert.rejects(new Email({ env: ENV(silent.port), timeoutMs: 200 }).post(MSG), /タイムアウト/);

  await assert.rejects(new Email({ env: {} }).post(MSG), /SMTP_URL・MAIL_FROM・MAIL_TO/);
  const closed = net.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  await assert.rejects(new Email({ env: ENV(port) }).post(MSG), /SMTP サーバーにつながりません/);
});

test('本文: text と html。利用者の文字列は HTML として逃がし、件名には期間だけを入れる', () => {
  const r = buildReport({
    sessions: [one(1, '<script>alert(1)</script> & "q" \'s\' @room')],
    tasks: [{ id: 'WEB-1', label: 'WEB-1<b>', url: 'https://x.example/browse/WEB-1?a=1&b="2"', issue: { title: 'A<B', stateLabel: 'Done' }, sessions: [{ id: 's1' }] }, { id: 'X', label: 'X', url: 'javascript:alert(1)', sessions: [{ id: 's1' }] }],
    costs: { buckets: [{ usd: 2 }] },
    range,
  });
  const m = toEmail(r, { includeCost: true });
  assert.equal(m.subject, 'Work Log 日報 2026/10/4(日)');
  assert.ok(m.text.startsWith('Work Log 日報 2026/10/4(日)\n作業 20分・1セッション・0コミット・API換算 $2.00(参考値)\n\n■ プロジェクト別\n・web  20分(1セッション・0コミット)'), m.text);
  assert.ok(m.text.includes(`<script>alert(1)</script> & "q" 's' @room`));
  assert.ok(m.text.endsWith('\n-- \nローカルの AI コーディングツールのセッションログから Work Log で作成'));
  assert.equal(m.preview, m.text);
  assert.equal(plainFromEmail(m.preview), m.text);
  assert.doesNotMatch(m.html, /<script>|<b>|javascript:/);
  assert.ok(m.html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot; &#39;s&#39; @room'));
  assert.ok(m.html.includes('<a href="https://x.example/browse/WEB-1?a=1&amp;b=%222%22">WEB-1&lt;b&gt;</a> A&lt;B(Done)'), m.html);
  assert.match(m.html, /^<!DOCTYPE html>\n<html lang="ja">/);
  assert.doesNotMatch(toEmail(r).text, /\$/);
  // 既定ではチャットより多い 100 セッションまで載せる
  const many = toEmail(buildReport({ sessions: Array.from({ length: 120 }, (_, i) => one(i)), range }));
  assert.match(many.text, /ほか 20 セッション/);
});

test('セッション終了の通知(メール)', () => {
  const m = sessionEndEmail({ displayTitle: 'ログイン修正\r\nBcc: x', project: 'web', activeMs: 25 * 60000, commits: 1, tasks: [{ label: '#12', url: 'https://github.com/a/b/issues/12' }] });
  assert.equal(m.subject, 'セッション終了: ログイン修正 Bcc: x');
  assert.ok(m.text.startsWith('セッション終了: ログイン修正 Bcc: x\nweb・25分・1コミット\nタスク: #12 (https://github.com/a/b/issues/12)'), m.text);
  assert.ok(m.html.includes('<a href="https://github.com/a/b/issues/12">#12</a>'));
});

// ストアを通した送信(偽の SMTP サーバーへ)。送った内容は復号して比べる(base64 のままでは伏せたかどうか分からない)
const smtp = fakeSmtp({ auth: ['PLAIN'] });
const port = await smtp.listen();
smtp.server.unref();
const decoded = (d) => `${decodeWords(parse(d).header('Subject'))}\n${parse(d).parts.map((p) => p.body).join('\n')}\n${d}`;
storeTests('email', {
  make: () => {
    const mark = smtp.log.messages.length;
    const client = new Email({ env: { SMTP_URL: `smtp://mailuser:Sup3rSecretPw@localhost:${port}`, MAIL_FROM: 'worklog@example.com', MAIL_TO: 'team@example.com' } });
    return { client, sent: () => smtp.log.messages.slice(mark).map((x) => decoded(x.data)) };
  },
  secret: 'Sup3rSecretPw',
  sentText: (sent) => sent.join('\n'),
  endPattern: /^セッション終了: \[GITHUB_TOKEN\] を使う修正/,
});
