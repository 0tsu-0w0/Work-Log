// LINE WORKS への送信(Bot API 2.0)。サービスアカウントの JWT(RS256。iss=Client ID、sub=サービスアカウント、iat/exp)を
// 秘密鍵で署名し、POST https://auth.worksmobile.com/oauth2/v2.0/token(grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer、
// assertion、client_id、client_secret、scope=bot)でアクセストークンに換え、期限まで使い回す。
// 送信は POST https://www.worksapis.com/v1.0/bots/{botId}/channels/{channelId}/messages に { content: { type: 'text', text } }。
// 環境変数: LINEWORKS_CLIENT_ID / LINEWORKS_CLIENT_SECRET / LINEWORKS_SERVICE_ACCOUNT / LINEWORKS_PRIVATE_KEY(PEM。改行は \n でもよい)
// または LINEWORKS_PRIVATE_KEY_FILE / LINEWORKS_BOT_ID / LINEWORKS_CHANNEL_ID(config.json の lineworks.channelId でもよい)。
// テスト用に、認証と API の場所を WORKLOG_LINEWORKS_AUTH(トークンの URL)/ WORKLOG_LINEWORKS_API(API の基点)で変えられる。
// 確認したこと: 公式のドキュメントは届かないので、LINE WORKS の API を使う公開パッケージの実装(nworks、chat-adapter-lineworks、
// lineworks-mcp-server)の URL・JWT の項目・scope・Authorization: Bearer・本文の形・テキスト 2000 文字の制限。
// 確認できていないこと: 実際の LINE WORKS への送信、公式ドキュメントとの突き合わせ(JWT の署名は自前の鍵とテストで検証している)。
// 秘密鍵・Client Secret・トークンはサーバー側だけで使い、ブラウザには渡さない。
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const TIMEOUT_MS = 10000;
const AUTH_URL = 'https://auth.worksmobile.com/oauth2/v2.0/token';
const API_BASE = 'https://www.worksapis.com/v1.0';
const b64url = (x) => Buffer.from(x).toString('base64url');

export class LineWorks {
  constructor({ env = process.env, fetchImpl = fetch, config = {}, now = Date.now } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.now = now;
    this.cached = null; // { token, expiresAt }
    this.setConfig(config);
  }

  setConfig(cfg = {}) {
    this.cfg = cfg && typeof cfg === 'object' ? cfg : {};
  }

  channelId() {
    return String(this.env.LINEWORKS_CHANNEL_ID || this.cfg.channelId || '').trim() || null;
  }

  configured() {
    const e = this.env;
    return Boolean(e.LINEWORKS_CLIENT_ID && e.LINEWORKS_CLIENT_SECRET && e.LINEWORKS_SERVICE_ACCOUNT && (e.LINEWORKS_PRIVATE_KEY || e.LINEWORKS_PRIVATE_KEY_FILE) && e.LINEWORKS_BOT_ID && this.channelId());
  }

  status() {
    const ok = this.configured();
    return {
      configured: ok,
      mode: ok ? 'bot' : null,
      destination: ok ? 'Bot' : null,
      includeCost: Boolean(this.cfg.includeCost),
      notify: this.cfg.notify === 'session_end' ? 'session_end' : null,
    };
  }

  async privateKey() {
    if (this.env.LINEWORKS_PRIVATE_KEY) return this.env.LINEWORKS_PRIVATE_KEY.replace(/\\n/g, '\n');
    return readFile(this.env.LINEWORKS_PRIVATE_KEY_FILE, 'utf8');
  }

  async assertion() {
    const iat = Math.floor(this.now() / 1000);
    const head = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: this.env.LINEWORKS_CLIENT_ID, sub: this.env.LINEWORKS_SERVICE_ACCOUNT, iat, exp: iat + 3600 }))}`;
    let sig;
    try {
      sig = createSign('RSA-SHA256').update(head).sign(await this.privateKey()).toString('base64url');
    } catch (err) {
      throw new Error(`LINE WORKS の秘密鍵を読めません(${err.code === 'ENOENT' ? 'LINEWORKS_PRIVATE_KEY_FILE のファイルがありません' : 'PEM 形式の RSA 秘密鍵が必要です'})`);
    }
    return `${head}.${sig}`;
  }

  async request(url, init) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      return await this.fetch(url, { ...init, redirect: 'error', signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // アクセストークン。期限の1分前までは使い回す
  async accessToken() {
    if (this.cached && this.cached.expiresAt - 60000 > this.now()) return this.cached.token;
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: await this.assertion(),
      client_id: this.env.LINEWORKS_CLIENT_ID,
      client_secret: this.env.LINEWORKS_CLIENT_SECRET,
      scope: 'bot',
    });
    const res = await this.request(this.env.WORKLOG_LINEWORKS_AUTH || AUTH_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.access_token) throw new Error(`LINE WORKS の認証に失敗しました ${res.status}: ${String(j?.error_description || j?.error || '').slice(0, 200)}`);
    this.cached = { token: j.access_token, expiresAt: this.now() + (Number(j.expires_in) || 86400) * 1000 };
    return j.access_token;
  }

  // messages: テキストのメッセージ(1通2000文字まで)を順に送る。途中で失敗したらそこで止める
  async post({ messages }) {
    if (!this.configured()) throw new Error('LINE WORKS の送り先が設定されていません(LINEWORKS_CLIENT_ID / LINEWORKS_CLIENT_SECRET / LINEWORKS_SERVICE_ACCOUNT / LINEWORKS_PRIVATE_KEY / LINEWORKS_BOT_ID / LINEWORKS_CHANNEL_ID)');
    const url = `${(this.env.WORKLOG_LINEWORKS_API || API_BASE).replace(/\/$/, '')}/bots/${encodeURIComponent(this.env.LINEWORKS_BOT_ID)}/channels/${encodeURIComponent(this.channelId())}/messages`;
    for (const text of messages) {
      let res;
      // トークンが失効していたら(401)、取り直して1回だけやり直す
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await this.accessToken();
        res = await this.request(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ content: { type: 'text', text } }) });
        if (res.status !== 401) break;
        this.cached = null;
      }
      if (res.status === 429) throw new Error(`LINE WORKS の送信が制限されています(${res.headers.get('retry-after') || '少し'}秒後に再試行してください)`);
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(`LINE WORKS Bot API ${res.status}: ${String(j?.description || j?.code || '').slice(0, 200)}`);
      }
    }
    return { url: null };
  }
}
