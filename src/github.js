// GitHub Issues 連携: タスクに紐付いた issue / PR のタイトル・状態・ラベルを取得し、作業記録のコメントを投稿する。
// キャッシュ・再確認の間隔・API 制限の扱いは trackers/base.js の共通部分を使う。
// 取得結果は ~/.work-log/github.json に保存し、条件付きリクエスト(ETag)で再確認する(304 はレート制限を消費しない)。
import { execFile } from 'node:child_process';
import { CachedTracker, safeColor } from './trackers/base.js';

// owner は英数字とハイフン、repo は英数字・_・.・- ("." や ".." だけの名前は不可)。API の URL にそのまま入るので厳しめに
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/(?!\.{1,2}$)[\w.-]+$/;

// トークン: 環境変数 GITHUB_TOKEN / GH_TOKEN、無ければ GitHub CLI(gh auth token)。どれも無ければ未認証で公開リポジトリだけ読む
export function tokenFromGh() {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { timeout: 3000 }, (err, stdout) => resolve(err ? null : stdout.trim() || null));
  });
}

export function pickIssue(j) {
  const pr = j.pull_request || null;
  const state = pr?.merged_at ? 'merged' : j.state; // open / closed / merged
  const notPlanned = j.state_reason === 'not_planned';
  return {
    title: j.title,
    state,
    stateReason: j.state_reason || null, // completed / not_planned など
    // 表示用の分類: 閉じた PR(マージなし)と「見送り」で閉じた issue は canceled
    stateCategory: state === 'open' ? (j.draft ? 'in_progress' : 'open') : state === 'merged' || (!pr && !notPlanned) ? 'done' : 'canceled',
    stateLabel: state === 'merged' ? 'Merged' : state === 'open' ? (j.draft ? 'Draft' : 'Open') : 'Closed',
    kindLabel: pr ? 'PR' : 'Issue',
    isPR: Boolean(pr),
    draft: Boolean(j.draft),
    // 色は画面の style 属性に入るので、6桁の16進数以外は捨てる
    labels: (j.labels || []).map((l) => (typeof l === 'string' ? { name: l, color: null } : { name: l.name, color: safeColor(l.color) })),
    assignees: (j.assignees || []).map((a) => a.login),
    url: j.html_url,
    comments: j.comments ?? 0,
    updatedAt: j.updated_at,
    closedAt: j.closed_at || null,
  };
}

export class GitHubIssues extends CachedTracker {
  constructor({ cacheDir, env = process.env, fetchImpl = fetch, tokenProvider = tokenFromGh, apiBase } = {}) {
    super({ name: 'github', label: 'GitHub', cacheDir, file: 'github.json', env, fetchImpl });
    this.apiBase = (apiBase || env.WORKLOG_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
    this.tokenProvider = tokenProvider;
  }

  itemKey(r) {
    return `${r.repo}#${r.number}`;
  }

  valid(r) {
    return REPO_RE.test(r.repo || '') && Number.isInteger(r.number);
  }

  async token() {
    if (this._token === undefined) {
      this._token = this.env.GITHUB_TOKEN || this.env.GH_TOKEN || (this.env.WORKLOG_GITHUB_NO_GH === '1' ? null : await this.tokenProvider());
    }
    return this._token;
  }

  async authenticated() {
    return Boolean(await this.token());
  }

  async headers() {
    const h = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
    const token = await this.token();
    if (token) h.authorization = `Bearer ${token}`;
    return h;
  }

  async fetchItem(r, entry, now) {
    const res = await this.http('GET', `${this.apiBase}/repos/${r.repo}/issues/${r.number}`, { headers: await this.headers(), etag: entry?.etag });
    if (res.status === 304 && entry) return { ...entry, fetchedAt: now };
    if (!res.ok) return { ...(entry || {}), error: this.errorOf(res, now), fetchedAt: now };
    return { etag: res.headers.get('etag'), fetchedAt: now, data: pickIssue(await res.json()) };
  }

  // 以前の呼び出し方(リポジトリと番号)も使えるようにしておく
  get(repo, number, opts) {
    return this.getRef({ repo, number }, opts);
  }

  async comment(refOrRepo, numberOrBody, maybeBody) {
    const [r, body] = typeof refOrRepo === 'string' ? [{ repo: refOrRepo, number: numberOrBody }, maybeBody] : [refOrRepo, numberOrBody];
    if (!this.valid(r)) throw new Error('issue の指定が不正です');
    if (!(await this.token())) throw new Error('コメントの投稿には GitHub のトークンが必要です(GITHUB_TOKEN か gh auth login)');
    const res = await this.http('POST', `${this.apiBase}/repos/${r.repo}/issues/${r.number}/comments`, {
      headers: { ...(await this.headers()), 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const j = await res.json();
    this.invalidate(r); // コメント数が変わるので次回は取り直す
    return { url: j.html_url };
  }
}
