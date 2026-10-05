// Redmine の課題の取得と、作業記録の注記(コメント)の投稿。
// 本物のサーバーで確かめたもの(Docker の redmine:6 = Redmine 6.1.5.stable、SQLite、2026-10):
//   GET /issues/{id}.json(subject / status.name / status.is_closed / tracker / assigned_to / priority / updated_on)、
//   X-Redmine-API-Key ヘッダーでの認証、PUT /issues/{id}.json {issue:{notes}} が 204(本文なし)を返すこと、
//   GET /issues/{id}.json?include=journals で投稿した注記の journal id が分かり、課題の画面に id="change-{id}" があること、
//   新しく入れた Redmine の既定の書式(Setting.text_formatting)が "common_mark"(Markdown)であること、
//   書式を textile にしたサーバーで、Textile の作業記録(worklog.js)が表として表示されること(課題の画面の HTML で確認)。
//   公開プロジェクトは鍵が間違っていても匿名で読める(200)ので、鍵の誤りは投稿のときに初めて分かる。
//   書式は API からは分からない(設定の API が無い)ので、config.json の tasks.redmine.format で指定する。
// 確かめていないもの: Redmine 5.x 以前(status.is_closed が無い版は状態の名前から推測する)、非公開プロジェクトでの 401/403 の応答。
// 設定: 環境変数 REDMINE_URL と REDMINE_API_KEY。config.json の tasks.redmine に
//   { "baseUrl": "https://redmine.example.com"(REDMINE_URL の代わり), "format": "markdown" | "textile"(既定 markdown),
//     "projects": ["Work Log のプロジェクト名", …](このプロジェクトの "#123" を Redmine の課題とみなす。"*" ですべて),
//     "keys": ["RM"](RM-123 を Redmine の #123 とみなす) }
import { CachedTracker } from './base.js';

// 終わった状態のうち、名前から「見送り」とみなすもの
const CANCELED_RE = /reject|cancel|duplicate|won'?t|却下|中止|取り下げ|重複|見送/i;
const CLOSED_RE = /closed|resolved|done|終了|完了|解決/i;

// http(s) の URL だけを受け付け、末尾の / を落とす
export function baseUrlOf(v) {
  const s = String(v || '').trim().replace(/\/+$/, '');
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) && !u.search && !u.hash ? s : null;
  } catch {
    return null;
  }
}

// url が base の下にあれば、その残りのパス("/issues/12" など)を返す
export function pathUnder(base, url) {
  if (!base) return null;
  let b;
  let u;
  try {
    b = new URL(base);
    u = new URL(url);
  } catch {
    return null;
  }
  if (b.protocol !== u.protocol || b.host.toLowerCase() !== u.host.toLowerCase()) return null;
  const prefix = b.pathname.replace(/\/+$/, '');
  if (prefix && !(u.pathname === prefix || u.pathname.startsWith(`${prefix}/`))) return null;
  return u.pathname.slice(prefix.length) || '/';
}

export function redmineCategory(status) {
  const name = status?.name || '';
  const closed = typeof status?.is_closed === 'boolean' ? status.is_closed : CLOSED_RE.test(name) || CANCELED_RE.test(name);
  if (closed) return CANCELED_RE.test(name) ? 'canceled' : 'done';
  return status?.id === 1 || /^(new|open)$|新規|未着手/i.test(name) ? 'open' : 'in_progress';
}

export class RedmineIssues extends CachedTracker {
  constructor({ baseUrl, format, ...opts } = {}) {
    super({ name: 'redmine', label: 'Redmine', ...opts });
    this.baseUrl = baseUrlOf(baseUrl || this.env.REDMINE_URL);
    this.format = format === 'textile' ? 'textile' : 'markdown';
  }
  itemKey(r) {
    return String(r.number);
  }
  valid(r) {
    return Boolean(this.baseUrl) && Number.isInteger(r.number) && r.number > 0;
  }
  configured() {
    return Boolean(this.baseUrl);
  }
  key() {
    return this.env.REDMINE_API_KEY || null;
  }
  async authenticated() {
    return Boolean(this.key());
  }
  headers() {
    return { accept: 'application/json', ...(this.key() ? { 'x-redmine-api-key': this.key() } : {}) };
  }
  issueUrl(n) {
    return `${this.baseUrl}/issues/${n}`;
  }
  // "<REDMINE_URL>/issues/123" なら 123
  numberOfUrl(url) {
    const m = (pathUnder(this.baseUrl, url) || '').match(/^\/issues\/(\d{1,9})\/?$/);
    return m ? Number(m[1]) : null;
  }
  async fetchItem(r, entry, now) {
    const res = await this.http('GET', `${this.baseUrl}/issues/${r.number}.json`, { headers: this.headers() });
    if (!res.ok) return { ...(entry || {}), error: this.errorOf(res, now), fetchedAt: now };
    const i = (await res.json()).issue || {};
    return {
      fetchedAt: now,
      data: {
        title: i.subject,
        state: i.status?.name || null,
        stateCategory: redmineCategory(i.status),
        stateLabel: i.status?.name || '',
        kindLabel: i.tracker?.name || 'Redmine',
        isPR: false,
        draft: false,
        labels: i.category?.name ? [{ name: i.category.name, color: null }] : [],
        assignees: i.assigned_to?.name ? [i.assigned_to.name] : [],
        priority: i.priority?.name || null,
        url: this.issueUrl(r.number),
        updatedAt: i.updated_on,
      },
    };
  }
  commentFormat() {
    return this.format;
  }
  // 注記として追加する。応答は 204 で本文が無いので、注記の一覧から今の投稿を探してリンクを作る
  async comment(r, body) {
    if (!this.key()) throw new Error('Redmine へのコメントには REDMINE_API_KEY が必要です');
    const res = await this.http('PUT', `${this.baseUrl}/issues/${r.number}.json`, {
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ issue: { notes: body } }),
    });
    if (!res.ok) throw new Error(`Redmine API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    this.invalidate(r);
    let id = null;
    try {
      const j = await this.http('GET', `${this.baseUrl}/issues/${r.number}.json?include=journals`, { headers: this.headers() });
      if (j.ok) id = ((await j.json()).issue?.journals || []).filter((x) => x.notes === body).at(-1)?.id || null;
    } catch {
      // リンクが作れないだけなので、投稿は成功として扱う
    }
    return { url: id ? `${this.issueUrl(r.number)}#change-${id}` : this.issueUrl(r.number) };
  }
}
