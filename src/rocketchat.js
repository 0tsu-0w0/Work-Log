// Rocket.Chat への送信。管理画面の「インテグレーション」で作った Incoming Webhook
// (https://<host>/hooks/<id>/<token>)に { text } を POST する。自分のサーバーで動かすものなので、https であればどのホストでもよい。
// 確認したこと: RocketChat/Rocket.Chat 7.0.0 の apps/meteor/app/integrations/server/api/api.js(ルート hooks/:integrationId/:token、
// 失敗は success:false と error の JSON)と app/lib/server/functions/processWebhookMessage.ts(text / username / icon_emoji)、
// server/settings/message.ts(Message_MaxAllowedSize の初期値 5000)。
// 確認できていないこと: 実際のサーバーへの送信、Markdown の記号の逃がし方(確かな方法が見つからないので全角にしている)。
// Webhook の URL(token を含む)が認証情報なので、サーバー側だけで使いブラウザには渡さない。
const TIMEOUT_MS = 10000;
const PATH_RE = /^(\/[\w.~-]+)*\/hooks\/[A-Za-z0-9]+\/[^/]+\/?$/; // サブパスで動かしているサーバーも許す

export class RocketChat {
  constructor({ env = process.env, fetchImpl = fetch, config = {} } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.setConfig(config);
  }

  setConfig(cfg = {}) {
    this.cfg = cfg && typeof cfg === 'object' ? cfg : {};
  }

  // https の /hooks/<id>/<token> だけを受け付ける。テスト用に WORKLOG_ROCKETCHAT_WEBHOOK_ANY=1 なら http も許す
  webhook() {
    const u = this.env.ROCKETCHAT_WEBHOOK_URL;
    if (!u) return null;
    let url;
    try {
      url = new URL(u);
    } catch {
      return null;
    }
    if (this.env.WORKLOG_ROCKETCHAT_WEBHOOK_ANY === '1' && /^https?:$/.test(url.protocol)) return u;
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

  async post({ text }) {
    const url = this.webhook();
    if (!url) throw new Error('Rocket.Chat の送り先が設定されていません(ROCKETCHAT_WEBHOOK_URL)');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), redirect: 'error', signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) throw new Error(`Rocket.Chat の送信が制限されています(${res.headers.get('retry-after') || '少し'}秒後に再試行してください)`);
    const j = await res.json().catch(() => null);
    if (!res.ok || j?.success === false) throw new Error(`Rocket.Chat Webhook ${res.status}: ${String(j?.error || j?.message || '').slice(0, 200)}`);
    return { url: null };
  }
}
