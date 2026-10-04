// Microsoft Teams への送信。Workflows(Power Automate の「Webhook 要求を受信したらチャネルに投稿する」)の URL か、
// 従来の Incoming Webhook(*.webhook.office.com。廃止予定)の URL に、Adaptive Card を
// { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content }] } で POST する
// (MicrosoftDocs/msteams-docs の connectors-using.md の形)。どちらも投稿へのリンクは返らない。
// 1秒に4回を超えると制限される。Webhook の URL はサーバー側だけで使い、ブラウザには渡さない。
const TIMEOUT_MS = 10000;
const HOST_RE = /(^|\.)(logic\.azure\.com|powerplatform\.com|webhook\.office\.com)$/;

export class Teams {
  constructor({ env = process.env, fetchImpl = fetch, config = {} } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.setConfig(config);
  }

  setConfig(cfg = {}) {
    this.cfg = cfg && typeof cfg === 'object' ? cfg : {};
  }

  // Microsoft の Webhook のホストだけを受け付ける。別のドメインの URL を使うときは WORKLOG_TEAMS_WEBHOOK_ANY=1
  webhook() {
    const u = this.env.TEAMS_WEBHOOK_URL;
    if (!u) return null;
    let url;
    try {
      url = new URL(u);
    } catch {
      return null;
    }
    if (this.env.WORKLOG_TEAMS_WEBHOOK_ANY === '1' && /^https?:$/.test(url.protocol)) return u;
    return url.protocol === 'https:' && HOST_RE.test(url.hostname) ? u : null;
  }

  status() {
    const u = this.webhook();
    const legacy = u ? /webhook\.office\.com$/.test(new URL(u).hostname) : false;
    return {
      configured: Boolean(u),
      mode: u ? (legacy ? 'incoming_webhook' : 'workflows') : null,
      destination: u ? (legacy ? 'Incoming Webhook' : 'Workflows') : null,
      includeCost: Boolean(this.cfg.includeCost),
      notify: this.cfg.notify === 'session_end' ? 'session_end' : null,
    };
  }

  async post(message) {
    const url = this.webhook();
    if (!url) throw new Error('Teams の送り先が設定されていません(TEAMS_WEBHOOK_URL)');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message), redirect: 'error', signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) throw new Error(`Teams の送信が制限されています(${res.headers.get('retry-after') || '少し'}秒後に再試行してください)`);
    // Workflows は 202、従来の Incoming Webhook は 200(本文が "1" 以外ならエラーの説明)
    if (!res.ok) throw new Error(`Teams Webhook ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    if (res.status === 200) {
      const text = (await res.text().catch(() => '')).trim();
      if (text && text !== '1' && !text.startsWith('{')) throw new Error(`Teams Webhook: ${text.slice(0, 200)}`);
    }
    return { url: null };
  }
}
