// Chatwork への送信。API トークン(CHATWORK_API_TOKEN)と送り先のルームID(CHATWORK_ROOM_ID か config.json の chatwork.roomId)で、
// POST https://api.chatwork.com/v2/rooms/{room_id}/messages に body=... を application/x-www-form-urlencoded で送る。
// 応答は { message_id } で、投稿へのリンクは https://www.chatwork.com/#!rid{room}-{message_id}。
// 確認したこと: 公式の API 定義(chatwork/api の RAML: body は必須で 1〜65535 文字、self_unread、応答 message_id)と、
// 公式の MCP サーバー(@chatwork/mcp-server)の実装(ヘッダー X-ChatWorkToken、form-urlencoded)。
// 確認できていないこと: API への実際の送信(ネットワークの制限で届かない)、制限(429)の応答ヘッダーの正確な名前
// (retry-after か x-ratelimit-reset のどちらかを見る)。
// トークンはサーバー側だけで使い、ブラウザには渡さない。
const TIMEOUT_MS = 10000;
const API = 'https://api.chatwork.com/v2';

export class Chatwork {
  constructor({ env = process.env, fetchImpl = fetch, config = {} } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.setConfig(config);
  }

  setConfig(cfg = {}) {
    this.cfg = cfg && typeof cfg === 'object' ? cfg : {};
  }

  token() {
    return this.env.CHATWORK_API_TOKEN || null;
  }

  // ルームIDは数字だけ(URL の一部になるため)。環境変数が先で、無ければ config.json の chatwork.roomId
  roomId() {
    const id = String(this.env.CHATWORK_ROOM_ID || this.cfg.roomId || '').trim();
    return /^\d+$/.test(id) ? id : null;
  }

  status() {
    const ok = Boolean(this.token() && this.roomId());
    return {
      configured: ok,
      mode: ok ? 'token' : null,
      destination: ok ? `ルーム ${this.roomId()}` : null,
      includeCost: Boolean(this.cfg.includeCost),
      notify: this.cfg.notify === 'session_end' ? 'session_end' : null,
    };
  }

  async post({ body }) {
    const token = this.token();
    const room = this.roomId();
    if (!token || !room) throw new Error('Chatwork の送り先が設定されていません(CHATWORK_API_TOKEN と CHATWORK_ROOM_ID)');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await this.fetch(`${API}/rooms/${room}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-chatworktoken': token },
        body: new URLSearchParams({ body, self_unread: '0' }).toString(),
        redirect: 'error',
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const wait = res.headers.get('retry-after') || (reset ? Math.max(1, Math.ceil(reset - Date.now() / 1000)) : '少し');
      throw new Error(`Chatwork の送信が制限されています(${wait}秒後に再試行してください)`);
    }
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Chatwork API ${res.status}: ${String(Array.isArray(j?.errors) ? j.errors.join(', ') : '').slice(0, 200)}`);
    return { url: j?.message_id ? `https://www.chatwork.com/#!rid${room}-${j.message_id}` : null };
  }
}
