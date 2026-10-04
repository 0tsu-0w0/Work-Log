// Confluence Cloud にページとして保存する。日報・週報を1ページにし、同じ期間を送り直すと同じページを更新する。
// API は REST v2(https://<site>.atlassian.net/wiki/api/v2/...)。認証は メールアドレス + API トークンの Basic。
// 確認したこと: confluence.js 3.2.0(atlassian の OpenAPI から生成された SDK)の v2 の定義で、
//   POST /wiki/api/v2/pages(本文は spaceId / status / title / parentId / body: { representation: "storage", value })、
//   PUT /wiki/api/v2/pages/{id}(id / status / title / body / version.number)、GET /wiki/api/v2/pages/{id}、
//   応答の Page(id / status / version.number / _links.webui)の形。
// 確認できていないこと(公式ドキュメントとの実機での突き合わせ): エラー応答の細かい形(errors[].title / detail を読んでいる)、
//   同じスペースに同名のページがあるときのエラーの内容、429 の Retry-After の有無、webui を基準の URL(…/wiki)に足した URL の正しさ。
// 更新のときは、保存してあるバージョンではなく GET で今のバージョン番号を取り、+1 して PUT する(画面で編集されていても競合しにくい)。
// ページ ID は <cacheDir>/confluence-pages.json に「サイト・スペース・期間」ごとに覚える。API トークンはサーバー側だけで使う。
import path from 'node:path';
import { PageMap, request, jsonOf, upsert, periodKey } from './docutil.js';

const LABEL = 'Confluence';

export class Confluence {
  constructor({ env = process.env, fetchImpl = fetch, config = {}, cacheDir = null } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.pages = new PageMap(cacheDir ? path.join(cacheDir, 'confluence-pages.json') : null);
    this.setConfig(config);
  }

  setConfig(cfg = {}) {
    this.cfg = cfg && typeof cfg === 'object' ? cfg : {};
  }

  // https://<site>.atlassian.net/wiki だけを受け付ける(サイトの直下だけ書いたときは /wiki を補う)。別のホストは WORKLOG_CONFLUENCE_BASE_ANY=1
  baseUrl() {
    const u = this.env.CONFLUENCE_BASE_URL;
    if (!u) return null;
    let url;
    try {
      url = new URL(u);
    } catch {
      return null;
    }
    if (url.username || url.password || url.search || url.hash) return null;
    const p = url.pathname.replace(/\/+$/, '');
    if (this.env.WORKLOG_CONFLUENCE_BASE_ANY === '1' && /^https?:$/.test(url.protocol)) return `${url.origin}${p}`;
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.atlassian\.net$/i.test(url.hostname) || (p !== '' && p !== '/wiki')) return null;
    return `${url.origin}/wiki`;
  }

  spaceId() {
    const v = String(this.env.CONFLUENCE_SPACE_ID || this.cfg.spaceId || '').trim();
    return /^\d+$/.test(v) ? v : null;
  }

  parentId() {
    const v = String(this.env.CONFLUENCE_PARENT_ID || this.cfg.parentId || '').trim();
    return /^\d+$/.test(v) ? v : null;
  }

  auth() {
    const { CONFLUENCE_EMAIL: email, CONFLUENCE_API_TOKEN: token } = this.env;
    return email && token ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` : null;
  }

  status() {
    const ok = Boolean(this.baseUrl() && this.auth() && this.spaceId());
    return {
      configured: ok,
      mode: ok ? 'api' : null,
      destination: ok ? `${new URL(this.baseUrl()).hostname}(スペース ${this.spaceId()})` : null,
      includeCost: Boolean(this.cfg.includeCost),
      notify: null,
    };
  }

  async call(method, apiPath, body) {
    const res = await request(
      this.fetch,
      `${this.baseUrl()}${apiPath}`,
      { method, headers: { authorization: this.auth(), accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) },
      LABEL,
    );
    if (res.status === 429) throw new Error(`${LABEL} の送信が制限されています(${res.headers.get('retry-after') || '少し'}秒後に再試行してください)`);
    return { res, json: await jsonOf(res) };
  }

  fail({ res, json }) {
    const e = json?.errors?.[0];
    return new Error(`${LABEL} ${res.status}: ${String(e?.detail || e?.title || json?.message || '').slice(0, 200)}`);
  }

  async post(message) {
    if (!this.baseUrl() || !this.auth() || !this.spaceId()) throw new Error('Confluence の送り先が設定されていません(CONFLUENCE_BASE_URL / CONFLUENCE_EMAIL / CONFLUENCE_API_TOKEN / CONFLUENCE_SPACE_ID)');
    const key = `${new URL(this.baseUrl()).hostname}/${this.spaceId()}|${periodKey(message, LABEL)}`;
    const link = (json) => (typeof json?._links?.webui === 'string' && json._links.webui.startsWith('/') ? `${this.baseUrl()}${json._links.webui}` : null);
    const body = { representation: 'storage', value: message.body };
    return upsert(this.pages, key, {
      // 今のバージョンを読んで +1 する。ページが消されていたら(404・ゴミ箱)作り直す
      update: async (hit) => {
        const id = encodeURIComponent(hit.id);
        const cur = await this.call('GET', `/api/v2/pages/${id}`);
        if (cur.res.status === 404 || (cur.res.ok && cur.json?.status && cur.json.status !== 'current')) return null;
        if (!cur.res.ok) throw this.fail(cur);
        const n = Number(cur.json?.version?.number);
        if (!Number.isInteger(n)) throw new Error(`${LABEL}: ページのバージョンを読めませんでした`);
        const put = await this.call('PUT', `/api/v2/pages/${id}`, { id: String(hit.id), status: 'current', title: message.title, body, version: { number: n + 1, message: 'Work Log から更新' } });
        if (put.res.status === 404) return null;
        if (!put.res.ok) throw this.fail(put);
        return { id: String(hit.id), version: put.json?.version?.number ?? n + 1, url: link(put.json) || hit.url || null };
      },
      create: async () => {
        const parentId = this.parentId();
        const c = await this.call('POST', '/api/v2/pages', { spaceId: this.spaceId(), status: 'current', title: message.title, ...(parentId ? { parentId } : {}), body });
        if (!c.res.ok) throw this.fail(c);
        if (!c.json?.id) throw new Error(`${LABEL}: 作成したページの ID を読めませんでした`);
        return { id: String(c.json.id), version: c.json.version?.number ?? 1, url: link(c.json) };
      },
    });
  }
}
