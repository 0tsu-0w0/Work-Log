// esa(esa.io)に記事として保存する。日報・週報を1記事にし、同じ期間を送り直すと同じ記事を更新する。
// 認証は Authorization: Bearer <アクセストークン>。記事の作成は POST /v1/teams/{team}/posts、更新は PATCH /v1/teams/{team}/posts/{number}
// (どちらも { post: { name, category, body_md, wip, message } } で送る)。応答に number と url が入る。
// 確認したこと: esa-node 0.2.2 と esa gem 3.7.0 の中身(https://api.esa.io/v1、Bearer、create_post / update_post のパスと { post: … } の包み方、
//   記事の項目 name / category / body_md / wip / message / url / number、429 のときは Retry-After ヘッダー)。
// 確認できていないこと(公式ドキュメントとの実機での突き合わせ): エラー応答の本文の形(message / error を読んでいる)、
//   同じカテゴリに同名の記事があるときのエラー、記事名に / を含めたときの扱い(題名はハイフン区切りにして避けている)。
// カテゴリは config.json の esa.category(既定は 日報 → "Work Log/日報"、週報 → "Work Log/週報")。%{year} %{month} %{day} %{kind} は期間の開始日と 日報・週報 に置き換える。
// 記事の番号は <cacheDir>/esa-pages.json に「チーム・期間」ごとに覚える。アクセストークンはサーバー側だけで使う。
import path from 'node:path';
import { PageMap, request, jsonOf, upsert, periodKey } from './docutil.js';

const LABEL = 'esa';
const API = 'https://api.esa.io/v1';

export class Esa {
  constructor({ env = process.env, fetchImpl = fetch, config = {}, cacheDir = null } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.pages = new PageMap(cacheDir ? path.join(cacheDir, 'esa-pages.json') : null);
    this.setConfig(config);
  }

  setConfig(cfg = {}) {
    this.cfg = cfg && typeof cfg === 'object' ? cfg : {};
  }

  team() {
    const v = String(this.env.ESA_TEAM || this.cfg.team || '').trim();
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v) ? v : null;
  }

  token() {
    return this.env.ESA_ACCESS_TOKEN || null;
  }

  // "日報/%{year}/%{month}" のような指定を、期間の開始日で置き換える。前後と重なった / は取り除く
  category(message) {
    const [y, m, d] = message.start.split('-');
    const kind = message.period === 'week' ? '週報' : '日報';
    const tpl = typeof this.cfg.category === 'string' && this.cfg.category.trim() ? this.cfg.category : `Work Log/${kind}`;
    const vars = { year: y, month: m, day: d, kind };
    return tpl
      .replace(/%\{(\w+)\}/g, (all, k) => vars[k] ?? all)
      .split('/')
      .map((x) => x.trim())
      .filter(Boolean)
      .join('/')
      .slice(0, 250);
  }

  status() {
    const ok = Boolean(this.team() && this.token());
    return {
      configured: ok,
      mode: ok ? 'api' : null,
      destination: ok ? `${this.team()}.esa.io` : null,
      includeCost: Boolean(this.cfg.includeCost),
      notify: null,
    };
  }

  async call(method, apiPath, post) {
    const res = await request(
      this.fetch,
      `${API}/teams/${this.team()}${apiPath}`,
      { method, headers: { authorization: `Bearer ${this.token()}`, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ post }) },
      LABEL,
    );
    if (res.status === 429) throw new Error(`${LABEL} の送信が制限されています(${res.headers.get('retry-after') || '少し'}秒後に再試行してください)`);
    return { res, json: await jsonOf(res) };
  }

  async post(message) {
    if (!this.team() || !this.token()) throw new Error('esa の送り先が設定されていません(ESA_ACCESS_TOKEN / ESA_TEAM)');
    const key = `${this.team()}|${periodKey(message, LABEL)}`;
    const wip = Boolean(this.cfg.wip);
    const post = { name: message.title, category: this.category(message), body_md: message.body, message: 'Work Log から送信' };
    const fail = ({ res, json }) => new Error(`${LABEL} ${res.status}: ${String(json?.message || json?.error || '').slice(0, 200)}`);
    const out = (json, hit) => ({ id: json?.number ?? hit?.id, url: typeof json?.url === 'string' ? json.url : hit?.url || null });
    return upsert(this.pages, key, {
      // 更新では wip を省く(esa の画面で Ship it した記事を、下書きに戻さないため)。下書きにしたいときだけ wip: true
      update: async (hit) => {
        const r = await this.call('PATCH', `/posts/${encodeURIComponent(hit.id)}`, { ...post, ...(wip ? { wip } : {}), message: 'Work Log から更新' });
        if (r.res.status === 404) return null;
        if (!r.res.ok) throw fail(r);
        return out(r.json, hit);
      },
      create: async () => {
        const r = await this.call('POST', '/posts', { ...post, wip });
        if (!r.res.ok) throw fail(r);
        if (r.json?.number == null) throw new Error(`${LABEL}: 作成した記事の番号を読めませんでした`);
        return out(r.json);
      },
    });
  }
}
