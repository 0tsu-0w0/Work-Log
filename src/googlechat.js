// Google Chat への送信。スペースの「アプリと統合」で作った Webhook の URL
// (https://chat.googleapis.com/v1/spaces/{space}/messages?key=...&token=...)に、
// Chat API の Message と同じ形の JSON({ text })を POST する。
// Webhook の応答には name(spaces/{space}/messages/{id})と thread.name しか入らず、投稿を開くリンクは返らない。
// URL の key と token が認証情報なので、サーバー側だけで使いブラウザには渡さない。
const TIMEOUT_MS = 10000;
const URL_RE = /^\/v1\/spaces\/[\w-]+\/messages$/;

export class GoogleChat {
  constructor({ env = process.env, fetchImpl = fetch, config = {} } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.setConfig(config);
  }

  setConfig(cfg = {}) {
    this.cfg = cfg && typeof cfg === 'object' ? cfg : {};
  }

  // chat.googleapis.com のスペースへの Webhook だけを受け付ける。別の URL を使うときは WORKLOG_GOOGLE_CHAT_WEBHOOK_ANY=1
  webhook() {
    const u = this.env.GOOGLE_CHAT_WEBHOOK_URL;
    if (!u) return null;
    let url;
    try {
      url = new URL(u);
    } catch {
      return null;
    }
    if (this.env.WORKLOG_GOOGLE_CHAT_WEBHOOK_ANY === '1' && /^https?:$/.test(url.protocol)) return u;
    return url.protocol === 'https:' && url.hostname === 'chat.googleapis.com' && URL_RE.test(url.pathname) ? u : null;
  }

  status() {
    const u = this.webhook();
    return {
      configured: Boolean(u),
      mode: u ? 'webhook' : null,
      destination: u ? 'Webhook' : null,
      includeCost: Boolean(this.cfg.includeCost),
      notify: this.cfg.notify === 'session_end' ? 'session_end' : null,
    };
  }

  async post({ text }) {
    const url = this.webhook();
    if (!url) throw new Error('Google Chat の送り先が設定されていません(GOOGLE_CHAT_WEBHOOK_URL)');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ text }), redirect: 'error', signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) throw new Error(`Google Chat の送信が制限されています(${res.headers.get('retry-after') || '少し'}秒後に再試行してください)`);
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      throw new Error(`Google Chat Webhook ${res.status}: ${String(j?.error?.message || j?.error?.status || '').slice(0, 200)}`);
    }
    return { url: null };
  }
}
