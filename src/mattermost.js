// Mattermost への送信。チャンネルの Incoming Webhook(https://<host>/hooks/<id>)に { text, username?, icon_url? } を POST する。
// 自分のサーバーで動かすものなので、https であればどのホストでもよい(パスは /hooks/<英数字のID> に限る)。
// 確認したこと: mattermost/mattermost の server/channels/web/webhook.go(ルート /hooks/{id:[A-Za-z0-9]+}、JSON の本文)と
// server/public/model/incoming_webhook.go(text / username(64文字まで) / icon_url(1024文字まで))、
// app/webhook.go(上限を超える投稿は自動で分割される)、model/post.go と store(投稿の上限は DB の列の大きさで決まる)。
// 16383 文字は古いサーバーの上限なので、それに合わせて本文を作っている。
// 確認できていないこと: 実際のサーバーへの送信。
// Webhook の URL が認証情報なので、サーバー側だけで使いブラウザには渡さない。
const TIMEOUT_MS = 10000;
const PATH_RE = /^(\/[\w.~-]+)*\/hooks\/[A-Za-z0-9]+\/?$/; // サブパスで動かしているサーバーも許す

export class Mattermost {
  constructor({ env = process.env, fetchImpl = fetch, config = {} } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.setConfig(config);
  }

  setConfig(cfg = {}) {
    this.cfg = cfg && typeof cfg === 'object' ? cfg : {};
  }

  // https の /hooks/<id> だけを受け付ける。テスト用に WORKLOG_MATTERMOST_WEBHOOK_ANY=1 なら http も許す
  webhook() {
    const u = this.env.MATTERMOST_WEBHOOK_URL;
    if (!u) return null;
    let url;
    try {
      url = new URL(u);
    } catch {
      return null;
    }
    if (this.env.WORKLOG_MATTERMOST_WEBHOOK_ANY === '1' && /^https?:$/.test(url.protocol)) return u;
    return url.protocol === 'https:' && PATH_RE.test(url.pathname) ? u : null;
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

  // 表示名とアイコンは config.json の mattermost.username / iconUrl(任意)
  async post({ text }) {
    const url = this.webhook();
    if (!url) throw new Error('Mattermost の送り先が設定されていません(MATTERMOST_WEBHOOK_URL)');
    const payload = { text };
    if (typeof this.cfg.username === 'string' && this.cfg.username) payload.username = this.cfg.username.slice(0, 64);
    if (typeof this.cfg.iconUrl === 'string' && /^https?:\/\//.test(this.cfg.iconUrl)) payload.icon_url = this.cfg.iconUrl.slice(0, 1024);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) throw new Error(`Mattermost の送信が制限されています(${res.headers.get('retry-after') || '少し'}秒後に再試行してください)`);
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      throw new Error(`Mattermost Webhook ${res.status}: ${String(j?.message || '').slice(0, 200)}`);
    }
    return { url: null };
  }
}
