// メール(SMTP)での送信。依存なしの小さな SMTP クライアント(node:net / node:tls)。
//   SMTP_URL: smtp://user:pass@host:587(STARTTLS)か smtps://user:pass@host:465(最初から TLS)。ユーザー名とパスワードは URL エンコードして書く
//   MAIL_FROM: 差出人 / MAIL_TO: 宛先(カンマ区切りで複数)。config.json の email.from / email.to(文字列か配列)/ email.subjectPrefix でも設定でき、そちらを優先する
//   WORKLOG_SMTP_SECURE=1: smtp:// でも最初から TLS で話す(465 番は URL に関係なく最初から TLS)
//   WORKLOG_SMTP_INSECURE=1: 証明書を確かめない(手元のテスト用。普段は使わない)。自己署名の CA は NODE_EXTRA_CA_CERTS で足せる
// 流れ: 接続 → 220 → EHLO(だめなら HELO)→ STARTTLS(提示されていれば必ず使う)→ EHLO → AUTH PLAIN / LOGIN(認証情報があるとき)
//   → MAIL FROM → RCPT TO(宛先ごと。1つでも断られたら送らない)→ DATA(行頭の . は .. にする)→ QUIT。
// 認証情報があるのに TLS にならないときは、手元(localhost / 127.x / ::1)のサーバー以外には送らない(パスワードを平文で流さないため)。
// 本文(件名・text・html)は report.js の toEmail / sessionEndEmail が作り、秘匿情報はストアで伏せてから渡される。
// ヘッダーに CR / LF を含む値は入れない(件名は改行を空白にしてから RFC 2047 の B 符号化、アドレスは形を確かめる)。
// URL のパスワードはサーバー側だけで使い、status() にはホストとポートだけを返す。
//
// 実サーバーで確かめたこと(2026-10-05、Docker の axllent/mailpit v1.31.4):
//   - `work-log report --email` を次の3通りで送った: STARTTLS + AUTH PLAIN(MP_SMTP_TLS_CERT/KEY・MP_SMTP_REQUIRE_STARTTLS・
//     MP_SMTP_AUTH_ACCEPT_ANY。証明書は自前の CA で発行し NODE_EXTRA_CA_CERTS で検証)、最初から TLS(MP_SMTP_REQUIRE_TLS と smtps://、
//     WORKLOG_SMTP_SECURE=1 も)、TLS も認証もない平文(MP_SMTP_AUTH_ALLOW_INSECURE)。Mailpit の API(/api/v1/messages・/api/v1/message/{ID}・
//     /headers・/raw)で、件名の復号・宛先2件・From・text と html の両方・日本語・伏せたトークン・HTML の逃がし・余計なヘッダー(Bcc など)が無いこと、
//     認証したユーザー名(URL エンコードした user%2Bx → user+x)を確かめた。HTML は Playwright(Chromium)で表示してスクリーンショットで見た。
//   - 件名に CR/LF と "Bcc:" を入れても、ヘッダーは増えず件名の文字になること。長い日本語の件名を複数の encoded-word に分けても正しく復号されること。
//   - セッション終了の通知(email.notify = "session_end"、subjectPrefix 付き)。
//   - 証明書を確かめられない(CA を足さない)ときは送らないこと。STARTTLS の無いサーバーへ、手元以外の IP(Docker のブリッジ)では
//     パスワードを送らないこと。TLS 専用のポートへ平文でつなぐとタイムアウトのエラーになること。
//   - Mailpit の HTML Check では、メールソフトでの対応は「対応 68%・一部 29%・非対応 3%」(body の背景・border-radius・max-width など見た目だけ)。
// 確かめていないこと: AUTH LOGIN しか提示しないサーバー・HELO しか知らないサーバー・宛先を断るサーバー(偽のサーバーのテストのみ)、
//   Gmail・Microsoft 365・SES などの実際のサービスと実際のメールソフトでの表示、SMTPUTF8(日本語のメールアドレスは受け付けない)、
//   8BITMIME(本文は常に base64 で送る。このため DATA の行頭の . の処理は本物のサーバーでは働く場面が無かった)。
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

const TIMEOUT_MS = 20000;
const ADDR_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const isLoopback = (host) => host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);

const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x) => String(x).trim()).filter(Boolean);

// ヘッダーの値に CR / LF が入っていたら止める(ヘッダーの差し込みを防ぐ)
function headerValue(v) {
  const s = String(v);
  if (/[\r\n]/.test(s)) throw new Error('メールのヘッダーに改行を含む値は使えません');
  return s;
}

// RFC 2047 の encoded-word(UTF-8 / B)。1語 75 文字に収まるよう、文字の途中で切らずに分け、折り返して並べる
export function encodeWord(text) {
  const s = String(text ?? '').replace(/[\r\n]+/g, ' ');
  const words = [];
  let cur = '';
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch) > 45) {
      words.push(cur);
      cur = '';
    }
    cur += ch;
  }
  if (cur || !words.length) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}

// RFC 5322 の日付(例: Mon, 05 Oct 2026 09:30:00 +0000)
export function rfc5322Date(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

// text/* は改行を CRLF にそろえてから符号化する(RFC 2045 の正規形)
const b64lines = (s) => Buffer.from(s.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');

// メッセージ全体(CRLF 区切り)。from / to は確かめ済みのアドレス
export function buildMessage({ from, to, subject, text, html, now = Date.now(), id = randomBytes(12).toString('hex') }) {
  const domain = from.split('@')[1];
  const boundary = `=_worklog_${id}`;
  const headers = [
    `Date: ${rfc5322Date(now)}`,
    `Message-ID: <${id}.${now}@${domain}>`,
    `From: Work Log <${from}>`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeWord(subject)}`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    'X-Mailer: work-log',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  for (const h of headers) headerValue(h.replace(/\r\n /g, '')); // 折り返し(CRLF + 空白)は encodeWord が入れたものだけ許す
  const part = (type, body) => [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', b64lines(body)].join('\r\n');
  return [...headers, '', 'This is a multi-part message in MIME format.', '', part('text/plain', text), part('text/html', html), `--${boundary}--`, ''].join('\r\n');
}

// DATA で送る形: 改行を CRLF にそろえ、行頭の . を .. にして、最後に <CRLF>.<CRLF>
export function dotStuff(msg) {
  const body = String(msg).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  return `${body.endsWith('\r\n') ? body : `${body}\r\n`}.\r\n`;
}

// 応答を1つずつ読む(複数行の応答 "250-..." は最後の "250 ..." までまとめる)
class Conn {
  constructor(socket, timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.replies = [];
    this.waiters = [];
    this.lines = [];
    this.buf = '';
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    this.onData = (d) => this.feed(d);
    this.onErr = (err) => this.fail(err);
    this.onClose = () => this.fail(new Error('SMTP サーバーが接続を切りました'));
    socket.on('data', this.onData);
    socket.on('error', this.onErr);
    socket.on('close', this.onClose);
  }

  detach() {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onErr);
    this.socket.off('close', this.onClose);
  }

  feed(d) {
    this.buf += d.toString('utf8');
    if (this.buf.length > 1e6) return this.fail(new Error('SMTP サーバーの応答が長すぎます'));
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const m = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!m) return this.fail(new Error(`SMTP サーバーの応答を読めません: ${line.slice(0, 100)}`));
      this.lines.push(m[3]);
      if (m[2] !== '-') {
        const reply = { code: Number(m[1]), lines: this.lines, text: this.lines.join(' ') };
        this.lines = [];
        const w = this.waiters.shift();
        if (w) w.resolve(reply);
        else this.replies.push(reply);
      }
    }
  }

  fail(err) {
    this.error ||= err;
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  read() {
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.destroy();
        this.fail(new Error('SMTP サーバーの応答がありません(タイムアウト)'));
      }, this.timeoutMs);
      this.waiters.push({ resolve: (r) => (clearTimeout(timer), resolve(r)), reject: (e) => (clearTimeout(timer), reject(e)) });
    });
  }

  // コマンドを送って応答を待つ。expect に無いコードならエラー(what はエラーに出す名前。パスワードはエラーに出さない)
  async cmd(line, expect, what = line.split(' ')[0]) {
    if (line != null) this.socket.write(`${line}\r\n`);
    const r = await this.read();
    if (!expect.includes(r.code)) throw Object.assign(new Error(`SMTP ${what}: ${r.code} ${r.text.slice(0, 200)}`), { code: r.code });
    return r;
  }
}

function connect({ host, port, secure, servername, rejectUnauthorized, ca, lookup, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const opts = { host, port, ...(lookup ? { lookup } : {}), ...(secure ? { servername, rejectUnauthorized, ca, minVersion: 'TLSv1.2' } : {}) };
    const socket = secure ? tls.connect(opts) : net.connect(opts);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`SMTP サーバーにつながりません(${host}:${port}、タイムアウト)`));
    }, timeoutMs);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', onErr);
      resolve(socket);
    });
    const onErr = (err) => {
      clearTimeout(timer);
      reject(new Error(`SMTP サーバーにつながりません(${host}:${port}): ${err.message}`));
    };
    socket.once('error', onErr);
  });
}

function upgrade(socket, { servername, rejectUnauthorized, ca, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, servername, rejectUnauthorized, ca, minVersion: 'TLSv1.2' });
    const timer = setTimeout(() => {
      t.destroy();
      reject(new Error('STARTTLS の TLS 接続がタイムアウトしました'));
    }, timeoutMs);
    t.once('secureConnect', () => {
      clearTimeout(timer);
      t.removeListener('error', onErr);
      resolve(t);
    });
    const onErr = (err) => {
      clearTimeout(timer);
      reject(new Error(`STARTTLS に失敗しました: ${err.message}`));
    };
    t.once('error', onErr);
  });
}

// EHLO の応答から拡張の一覧(大文字の名前 → 引数)を作る
const extensions = (reply) => new Map(reply.lines.slice(1).map((l) => { const [k, ...v] = l.trim().split(/\s+/); return [k.toUpperCase(), v.map((x) => x.toUpperCase())]; }));

export class Email {
  // ca: 信頼する CA の証明書 / lookup: 名前解決(どちらもテスト用。普段は OS の証明書と NODE_EXTRA_CA_CERTS、OS の名前解決を使う)
  constructor({ env = process.env, config = {}, now = Date.now, timeoutMs = TIMEOUT_MS, ca, lookup } = {}) {
    this.env = env;
    this.ca = ca;
    this.lookup = lookup;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.setConfig(config);
  }

  setConfig(cfg = {}) {
    this.cfg = cfg && typeof cfg === 'object' ? cfg : {};
  }

  // SMTP_URL を読む。読めなければ null
  server() {
    const u = this.env.SMTP_URL;
    if (!u) return null;
    let url;
    try {
      url = new URL(u);
    } catch {
      return null;
    }
    if (!['smtp:', 'smtps:'].includes(url.protocol) || !url.hostname || (url.pathname && url.pathname !== '/') || url.search) return null;
    const port = Number(url.port) || (url.protocol === 'smtps:' ? 465 : 587);
    const secure = url.protocol === 'smtps:' || port === 465 || this.env.WORKLOG_SMTP_SECURE === '1';
    let user = '';
    let pass = '';
    try {
      user = decodeURIComponent(url.username);
      pass = decodeURIComponent(url.password);
    } catch {
      return null;
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    return { host: hostname, port, secure, user, pass, loopback: isLoopback(hostname), servername: net.isIP(hostname) ? undefined : hostname };
  }

  from() {
    const f = String(this.cfg.from || this.env.MAIL_FROM || '').trim();
    return ADDR_RE.test(f) ? f : null;
  }

  to() {
    const t = list(this.cfg.to).length ? list(this.cfg.to) : list(this.env.MAIL_TO);
    return t.length && t.length <= 50 && t.every((a) => ADDR_RE.test(a)) ? [...new Set(t)] : null;
  }

  status() {
    const s = this.server();
    const ok = Boolean(s && this.from() && this.to());
    return {
      configured: ok,
      mode: ok ? (s.secure ? 'smtps' : 'smtp') : null,
      destination: ok ? `${s.host.includes(':') ? `[${s.host}]` : s.host}:${s.port}` : null, // 認証情報と宛先は出さない
      includeCost: Boolean(this.cfg.includeCost),
      notify: this.cfg.notify === 'session_end' ? 'session_end' : null,
    };
  }

  // message: { subject, text, html }(report.js の toEmail / sessionEndEmail)
  async post({ subject, text, html }) {
    const s = this.server();
    const from = this.from();
    const to = this.to();
    if (!s || !from || !to) throw new Error('メールの送り先が設定されていません(SMTP_URL・MAIL_FROM・MAIL_TO)');
    const prefix = typeof this.cfg.subjectPrefix === 'string' ? this.cfg.subjectPrefix.replace(/[\r\n]+/g, ' ').slice(0, 100) : '';
    const data = buildMessage({ from, to, subject: `${prefix}${subject}`, text: String(text ?? ''), html: String(html ?? ''), now: this.now() });
    const rejectUnauthorized = this.env.WORKLOG_SMTP_INSECURE !== '1';
    const tlsOpts = { servername: s.servername, rejectUnauthorized, ca: this.ca, timeoutMs: this.timeoutMs };
    const socket = await connect({ host: s.host, port: s.port, secure: s.secure, lookup: this.lookup, ...tlsOpts });
    const c = new Conn(socket, this.timeoutMs);
    let secured = s.secure;
    try {
      await c.cmd(null, [220], '接続');
      const helo = os.hostname().match(/^[A-Za-z0-9.-]{1,200}$/) ? os.hostname() : 'localhost';
      const hello = async () => {
        try {
          return extensions(await c.cmd(`EHLO ${helo}`, [250]));
        } catch (err) {
          if (!err.code || err.code < 500) throw err;
          await c.cmd(`HELO ${helo}`, [250]);
          return new Map();
        }
      };
      let ext = await hello();
      if (!secured && ext.has('STARTTLS')) {
        await c.cmd('STARTTLS', [220]);
        c.detach();
        const t = await upgrade(c.socket, tlsOpts);
        c.attach(t);
        secured = true;
        ext = await hello();
      }
      if (s.user || s.pass) {
        if (!secured && !s.loopback) throw new Error('SMTP サーバーが STARTTLS に対応していないため、パスワードを送りませんでした(smtps:// か STARTTLS のあるサーバーを使ってください)');
        const mechs = ext.get('AUTH') || [];
        if (mechs.includes('PLAIN')) {
          await c.cmd(`AUTH PLAIN ${Buffer.from(`\0${s.user}\0${s.pass}`).toString('base64')}`, [235], 'AUTH PLAIN');
        } else if (mechs.includes('LOGIN')) {
          await c.cmd('AUTH LOGIN', [334], 'AUTH LOGIN');
          await c.cmd(Buffer.from(s.user).toString('base64'), [334], 'AUTH LOGIN');
          await c.cmd(Buffer.from(s.pass).toString('base64'), [235], 'AUTH LOGIN');
        } else {
          throw new Error(`SMTP サーバーが PLAIN / LOGIN の認証に対応していません(${mechs.join(' ') || 'AUTH なし'})`);
        }
      }
      await c.cmd(`MAIL FROM:<${headerValue(from)}>`, [250]);
      for (const r of to) await c.cmd(`RCPT TO:<${headerValue(r)}>`, [250, 251], 'RCPT TO');
      await c.cmd('DATA', [354]);
      c.socket.write(dotStuff(data));
      const done = await c.cmd(null, [250], 'DATA');
      await c.cmd('QUIT', [221]).catch(() => {});
      return { url: null, response: done.text.slice(0, 200) };
    } finally {
      c.detach();
      c.socket.on('error', () => {});
      c.socket.end();
      c.socket.destroy();
    }
  }
}
