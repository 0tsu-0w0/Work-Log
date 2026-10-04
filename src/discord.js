// Discord への送信(Incoming Webhook)。形は discord-api-types の型に合わせている:
// POST <Webhook URL>?wait=true に { content, embeds, allowed_mentions } を JSON で送り、作成されたメッセージを受け取る。
// 文中の @everyone などで通知が飛ばないよう、allowed_mentions は空にする。429 は retry_after(秒)。
// Webhook の URL はサーバー側だけで使い、ブラウザには渡さない。
const TIMEOUT_MS = 10000;
const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/(\d+)\/[\w-]+$/;

export class Discord {
  constructor({ env = process.env, fetchImpl = fetch, config = {} } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.setConfig(config);
  }

  setConfig(cfg = {}) {
    this.cfg = cfg && typeof cfg === 'object' ? cfg : {};
  }

  // Discord の Webhook の URL だけを受け付ける(テストでは WORKLOG_DISCORD_WEBHOOK_ANY=1 で任意の https を許す)
  webhook() {
    const u = this.env.DISCORD_WEBHOOK_URL;
    if (!u) return null;
    if (WEBHOOK_RE.test(u)) return u;
    return this.env.WORKLOG_DISCORD_WEBHOOK_ANY === '1' && /^https?:\/\//.test(u) ? u : null;
  }

  status() {
    const ok = Boolean(this.webhook());
    return {
      configured: ok,
      mode: ok ? 'webhook' : null,
      destination: ok ? 'Discord Webhook' : null,
      includeCost: Boolean(this.cfg.includeCost),
      notify: this.cfg.notify === 'session_end' ? 'session_end' : null,
    };
  }

  async post({ content = '', embeds = [] }) {
    const url = this.webhook();
    if (!url) throw new Error('Discord の送り先が設定されていません(DISCORD_WEBHOOK_URL)');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await this.fetch(`${url}?wait=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, embeds, username: this.cfg.username || 'Work Log', allowed_mentions: { parse: [] } }),
        redirect: 'error',
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      throw new Error(`Discord の API 制限中です(${j.retry_after ?? res.headers.get('retry-after') ?? '?'}秒後に再試行してください)`);
    }
    if (!res.ok) throw new Error(`Discord Webhook ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const m = await res.json().catch(() => null);
    // サーバーのメッセージへのリンク(guild_id が返るときだけ作れる)
    return { url: m?.guild_id && m?.channel_id && m?.id ? `https://discord.com/channels/${m.guild_id}/${m.channel_id}/${m.id}` : null };
  }
}
