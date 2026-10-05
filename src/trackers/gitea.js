// Gitea / Forgejo の issue・プルリクエストの取得と、作業記録のコメントの投稿(両者は同じ API /api/v1 を持つ)。
// 本物のサーバーで確かめたもの(Docker の gitea/gitea:latest = Gitea 28.0.0、SQLite、2026-10):
//   GET /api/v1/repos/{owner}/{repo}/issues/{n}(title / state / labels[].color は "#" なしの6桁 / assignees[].login /
//   html_url / pull_request はプルリクエストのときだけ値がある)、Authorization: token <トークン>、
//   POST …/issues/{n}/comments {body} が html_url(…/issues/{n}#issuecomment-{id})を返すこと、閉じた issue の状態、
//   存在しない issue は 404、誤ったトークンは 401 {"message":"invalid username, password or token"} になること。
// 確かめていないもの: Forgejo(codeberg.org のレジストリにこの環境から届かず、Docker Hub は利用制限で取得できなかった。
//   API は Gitea から分かれたもので同じ形のはずだが未確認)、プルリクエストのマージ済み・下書きの状態、ETag。
// 設定: 環境変数 GITEA_URL と GITEA_TOKEN(FORGEJO_URL / FORGEJO_TOKEN でも可)。config.json の tasks.gitea に
//   { "baseUrl": "https://git.example.com"(GITEA_URL の代わり), "repos": ["owner/repo", …](この "owner/repo#12" を Gitea のものとみなす) }
import { CachedTracker, safeColor } from './base.js';
import { baseUrlOf, pathUnder } from './redmine.js';

export class GiteaIssues extends CachedTracker {
  constructor({ baseUrl, repos, ...opts } = {}) {
    super({ name: 'gitea', label: 'Gitea', ...opts });
    this.baseUrl = baseUrlOf(baseUrl || this.env.GITEA_URL || this.env.FORGEJO_URL);
    this.repos = new Set((Array.isArray(repos) ? repos : []).map((r) => String(r).toLowerCase()));
  }
  host() {
    return this.baseUrl ? new URL(this.baseUrl).host : null;
  }
  // 設定(tasks.gitea.repos)で Gitea のものとしたリポジトリか
  hasRepo(repo) {
    return Boolean(this.baseUrl) && this.repos.has(String(repo || '').toLowerCase());
  }
  itemKey(r) {
    return `${r.repo}#${r.number}`;
  }
  valid(r) {
    return Boolean(this.baseUrl) && /^[\w.-]+\/[\w.-]+$/.test(r.repo || '') && !r.repo.split('/').some((p) => p === '.' || p === '..') && Number.isInteger(r.number) && r.number > 0;
  }
  configured() {
    return Boolean(this.baseUrl);
  }
  token() {
    return this.env.GITEA_TOKEN || this.env.FORGEJO_TOKEN || null;
  }
  async authenticated() {
    return Boolean(this.token());
  }
  headers() {
    return { accept: 'application/json', ...(this.token() ? { authorization: `token ${this.token()}` } : {}) };
  }
  issueUrl(repo, n, pull = false) {
    return `${this.baseUrl}/${repo}/${pull ? 'pulls' : 'issues'}/${n}`;
  }
  // "<GITEA_URL>/owner/repo/issues/12"(…/pulls/12)なら { repo, number, pull }
  refOfUrl(url) {
    const m = (pathUnder(this.baseUrl, url) || '').match(/^\/([\w.-]+\/[\w.-]+)\/(issues|pulls)\/(\d{1,9})\/?$/);
    return m ? { repo: m[1], number: Number(m[3]), pull: m[2] === 'pulls' } : null;
  }
  api(r, suffix = '') {
    const [owner, name] = r.repo.split('/');
    return `${this.baseUrl}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${r.number}${suffix}`;
  }
  async fetchItem(r, entry, now) {
    const res = await this.http('GET', this.api(r), { headers: this.headers(), etag: entry?.etag });
    if (res.status === 304 && entry) return { ...entry, fetchedAt: now };
    if (!res.ok) return { ...(entry || {}), error: this.errorOf(res, now), fetchedAt: now };
    const j = await res.json();
    const pr = j.pull_request || null;
    let cat = j.state === 'closed' ? 'done' : 'open';
    let label = j.state === 'closed' ? 'Closed' : 'Open';
    if (pr && j.state === 'closed') [cat, label] = pr.merged ? ['done', 'Merged'] : ['canceled', 'Closed'];
    if (pr && j.state === 'open' && pr.draft) [cat, label] = ['in_progress', 'Draft'];
    return {
      etag: res.headers.get('etag'),
      fetchedAt: now,
      data: {
        title: j.title,
        state: j.state,
        stateCategory: cat,
        stateLabel: label,
        kindLabel: pr ? 'PR' : 'Issue',
        isPR: Boolean(pr),
        draft: Boolean(pr?.draft),
        labels: (j.labels || []).map((l) => ({ name: l.name, color: safeColor(l.color) })),
        assignees: (j.assignees || []).map((a) => a.login),
        url: j.html_url || this.issueUrl(r.repo, r.number, Boolean(pr)),
        updatedAt: j.updated_at,
      },
    };
  }
  async comment(r, body) {
    if (!this.token()) throw new Error('Gitea へのコメントには GITEA_TOKEN が必要です');
    const res = await this.http('POST', this.api(r, '/comments'), { headers: { ...this.headers(), 'content-type': 'application/json' }, body: JSON.stringify({ body }) });
    if (!res.ok) throw new Error(`Gitea API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const j = await res.json();
    this.invalidate(r);
    return { url: j.html_url || this.issueUrl(r.repo, r.number) };
  }
}
