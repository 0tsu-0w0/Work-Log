// 汎用 Webhook への送信(Zapier / n8n / Make など)。WORKLOG_WEBHOOK_URL に、日報・週報とセッション終了の通知を JSON で POST する。
// URL は https か、手元の受け口(localhost / 127.0.0.1 / ::1)だけ http も使える。
// WORKLOG_WEBHOOK_SECRET を設定すると、本文(送るバイト列そのまま)の HMAC-SHA256 を X-WorkLog-Signature: sha256=<hex> に付ける。
// 受け取る側は同じ鍵で本文の HMAC を計算して比べる。X-WorkLog-Timestamp は送った時刻(秒)で、署名の対象には含まない
// (古い通知を捨てたい受け手が見る目安)。URL と鍵はサーバー側だけで使い、ブラウザには渡さない。
import { createHmac } from 'node:crypto';

const TIMEOUT_MS = 10000;

export class Webhook {
  constructor({ env = process.env, fetchImpl = fetch, config = {}, now = Date.now } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.now = now;
    this.setConfig(config);
  }

  setConfig(cfg = {}) {
    this.cfg = cfg && typeof cfg === 'object' ? cfg : {};
  }

  url() {
    const u = this.env.WORKLOG_WEBHOOK_URL;
    if (!u) return null;
    let url;
    try {
      url = new URL(u);
    } catch {
      return null;
    }
    if (url.protocol === 'https:') return u;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? u : null;
  }

  status() {
    const u = this.url();
    return {
      configured: Boolean(u),
      mode: u ? 'webhook' : null,
      destination: u ? new URL(u).host : null, // URL のパスや問い合わせに鍵が入ることがあるので、ホストだけ
      includeCost: Boolean(this.cfg.includeCost),
      notify: this.cfg.notify === 'session_end' ? 'session_end' : null,
    };
  }

  async post(payload) {
    const url = this.url();
    if (!url) throw new Error('Webhook の送り先が設定されていません(WORKLOG_WEBHOOK_URL は https か localhost の http)');
    const body = JSON.stringify(payload);
    const headers = { 'content-type': 'application/json; charset=UTF-8', 'user-agent': 'work-log' };
    const secret = this.env.WORKLOG_WEBHOOK_SECRET;
    if (secret) {
      headers['x-worklog-timestamp'] = String(Math.floor(this.now() / 1000));
      headers['x-worklog-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await this.fetch(url, { method: 'POST', headers, body, redirect: 'error', signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) throw new Error(`Webhook の送信が制限されています(${res.headers.get('retry-after') || '少し'}秒後に再試行してください)`);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Webhook ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    return { url: null };
  }
}
