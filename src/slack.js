// Slack への送信。Incoming Webhook か、Bot トークン + チャンネル(chat.postMessage)のどちらか。
// 形は公式 SDK に合わせている: Webhook は JSON を POST(リダイレクトは追わない)、
// Web API は Bearer トークンで form 形式(blocks は JSON 文字列)、429 は Retry-After。
// 認証情報(Webhook の URL・トークン)はサーバー側だけで使い、ブラウザには渡さない。
const TIMEOUT_MS = 10000;

export class Slack {
  constructor({ env = process.env, fetchImpl = fetch, config = {} } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.setConfig(config);
  }

  setConfig(cfg = {}) {
    this.cfg = cfg && typeof cfg === 'object' ? cfg : {};
  }

  webhook() {
    const u = this.env.SLACK_WEBHOOK_URL;
    return u && /^https:\/\//.test(u) ? u : null;
  }
  token() {
    return this.env.SLACK_BOT_TOKEN || null;
  }
  channel() {
    return this.cfg.channel || this.env.SLACK_CHANNEL || null;
  }
  apiBase() {
    return (this.env.WORKLOG_SLACK_API || 'https://slack.com/api').replace(/\/+$/, '');
  }

  // Bot トークンとチャンネルがあればそちらを優先(投稿のリンクが取れるため)
  mode() {
    if (this.token() && this.channel()) return 'bot';
    if (this.webhook()) return 'webhook';
    return null;
  }

  status() {
    const mode = this.mode();
    return {
      configured: Boolean(mode),
      mode,
      // 画面に出すのは送り先の種類とチャンネル名だけ(URL やトークンは出さない)
      destination: mode === 'bot' ? this.channel() : mode === 'webhook' ? 'Incoming Webhook' : null,
      includeCost: Boolean(this.cfg.includeCost),
      notify: this.cfg.notify === 'session_end' ? 'session_end' : null,
    };
  }

  async request(url, init) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      return await this.fetch(url, { ...init, signal: ac.signal, redirect: 'error' });
    } finally {
      clearTimeout(timer);
    }
  }

  async post({ text, blocks }) {
    const mode = this.mode();
    if (!mode) throw new Error('Slack の送り先が設定されていません(SLACK_WEBHOOK_URL、または SLACK_BOT_TOKEN と SLACK_CHANNEL)');
    if (mode === 'webhook') {
      const res = await this.request(this.webhook(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, blocks, unfurl_links: false }) });
      if (!res.ok) throw new Error(`Slack Webhook ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return { url: null };
    }
    const r = await this.call('chat.postMessage', { channel: this.channel(), text, blocks, unfurl_links: false });
    // 投稿へのリンク(取れなければ無しで済ませる)
    const link = await this.call('chat.getPermalink', { channel: r.channel, message_ts: r.ts }).catch(() => null);
    return { url: link?.permalink || null };
  }

  async call(method, params) {
    const body = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]));
    const res = await this.request(`${this.apiBase()}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token()}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (res.status === 429) throw new Error(`Slack の API 制限中です(${res.headers.get('retry-after') || '?'}秒後に再試行してください)`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) throw new Error(`Slack API ${method}: ${j.error || res.status}`);
    return j;
  }
}
