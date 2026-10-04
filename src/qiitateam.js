// Qiita Team に記事として保存する。日報・週報を1記事にし、同じ期間を送り直すと同じ記事を更新する。
// 送り先は <チーム名>.qiita.com の API(POST /api/v2/items で作成、PATCH /api/v2/items/{id} で更新)。
// 認証は Authorization: Bearer <アクセストークン>。qiita.com 本体(誰にでも公開される)には送らない。
// 確認したこと: qiita gem 1.6.0 と qiita-js 0.4.3 の中身(host: "<team>.qiita.com"、Bearer、create_item = POST /api/v2/items、
//   update_item = PATCH /api/v2/items/{id}、JSON の本文)。
// 確認できていないこと(公式ドキュメントとの実機での突き合わせ): 記事の項目(title / body / tags: [{ name, versions }] / private)の細かい仕様と
//   必須かどうか、応答の id / url、エラー応答の本文の形(message / type を読んでいる)、レート制限の応答(429 の Retry-After を想定)、
//   本文中の @ユーザー名 が通知になるかどうか(逃がしていない)。
// タグは 日報 / 週報(config.json の qiitateam.tags に文字列の配列を書くと置き換え。5個まで)。
// 記事の ID は <cacheDir>/qiitateam-pages.json に「チーム・期間」ごとに覚える。アクセストークンはサーバー側だけで使う。
import path from 'node:path';
import { PageMap, request, jsonOf, upsert, periodKey } from './docutil.js';

const LABEL = 'Qiita Team';

export class QiitaTeam {
  constructor({ env = process.env, fetchImpl = fetch, config = {}, cacheDir = null } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.pages = new PageMap(cacheDir ? path.join(cacheDir, 'qiitateam-pages.json') : null);
    this.setConfig(config);
  }

  setConfig(cfg = {}) {
    this.cfg = cfg && typeof cfg === 'object' ? cfg : {};
  }

  // "<team>.qiita.com"(https:// や末尾の / は付いていてもよい)だけを受け付ける。qiita.com 自体や、さらに深いサブドメインは不可
  host() {
    const v = String(this.env.QIITA_TEAM_DOMAIN || '').trim().replace(/^https:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    const m = /^([a-z0-9][a-z0-9-]*)\.qiita\.com$/.exec(v);
    return m && !['www', 'api'].includes(m[1]) ? v : null;
  }

  token() {
    return this.env.QIITA_ACCESS_TOKEN || null;
  }

  tags(message) {
    const own = Array.isArray(this.cfg.tags) ? this.cfg.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()) : [];
    return (own.length ? own : [message.period === 'week' ? '週報' : '日報']).slice(0, 5).map((name) => ({ name, versions: [] }));
  }

  status() {
    const ok = Boolean(this.host() && this.token());
    return {
      configured: ok,
      mode: ok ? 'api' : null,
      destination: ok ? this.host() : null,
      includeCost: Boolean(this.cfg.includeCost),
      notify: null,
    };
  }

  async call(method, apiPath, body) {
    const res = await request(
      this.fetch,
      `https://${this.host()}${apiPath}`,
      { method, headers: { authorization: `Bearer ${this.token()}`, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) },
      LABEL,
    );
    if (res.status === 429) throw new Error(`${LABEL} の送信が制限されています(${res.headers.get('retry-after') || '少し'}秒後に再試行してください)`);
    return { res, json: await jsonOf(res) };
  }

  async post(message) {
    if (!this.host() || !this.token()) throw new Error('Qiita Team の送り先が設定されていません(QIITA_TEAM_DOMAIN / QIITA_ACCESS_TOKEN)');
    const key = `${this.host()}|${periodKey(message, LABEL)}`;
    const item = { title: message.title, body: message.body, tags: this.tags(message), private: false };
    const fail = ({ res, json }) => new Error(`${LABEL} ${res.status}: ${String(json?.message || json?.type || '').slice(0, 200)}`);
    const out = (json, hit) => ({ id: json?.id ?? hit?.id, url: typeof json?.url === 'string' ? json.url : hit?.url || null });
    return upsert(this.pages, key, {
      update: async (hit) => {
        const r = await this.call('PATCH', `/api/v2/items/${encodeURIComponent(hit.id)}`, item);
        if (r.res.status === 404) return null;
        if (!r.res.ok) throw fail(r);
        return out(r.json, hit);
      },
      create: async () => {
        const r = await this.call('POST', '/api/v2/items', item);
        if (!r.res.ok) throw fail(r);
        if (!r.json?.id) throw new Error(`${LABEL}: 作成した記事の ID を読めませんでした`);
        return out(r.json);
      },
    });
  }
}
