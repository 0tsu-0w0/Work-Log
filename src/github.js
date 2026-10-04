// GitHub Issues 連携: タスクに紐付いた issue / PR のタイトル・状態・ラベルを取得し、作業記録のコメントを投稿する。
// トークンはサーバー側だけで使い、ブラウザには渡さない。取得結果は ~/.work-log/github.json に保存し、
// 条件付きリクエスト(ETag)で再確認する(304 はレート制限を消費しない)。
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';

const OPEN_TTL_MS = 10 * 60 * 1000; // 開いている issue は変わりやすいので短め
const CLOSED_TTL_MS = 24 * 60 * 60 * 1000;
const ERROR_TTL_MS = 30 * 60 * 1000; // 404(権限がない・存在しない)は何度も聞きに行かない
const REQUEST_TIMEOUT_MS = 8000;
const CONCURRENCY = 4;
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
  return {
    title: j.title,
    state: pr?.merged_at ? 'merged' : j.state, // open / closed / merged
    stateReason: j.state_reason || null, // completed / not_planned など
    isPR: Boolean(pr),
    draft: Boolean(j.draft),
    // 色は画面の style 属性に入るので、6桁の16進数以外は捨てる
    labels: (j.labels || []).map((l) => (typeof l === 'string' ? { name: l, color: null } : { name: l.name, color: /^[0-9a-f]{6}$/i.test(l.color || '') ? l.color : null })),
    assignees: (j.assignees || []).map((a) => a.login),
    url: j.html_url,
    comments: j.comments ?? 0,
    updatedAt: j.updated_at,
    closedAt: j.closed_at || null,
  };
}

export class GitHubIssues {
  constructor({ cacheDir, env = process.env, fetchImpl = fetch, tokenProvider = tokenFromGh, apiBase } = {}) {
    this.file = path.join(cacheDir, 'github.json');
    this.env = env;
    this.fetch = fetchImpl;
    this.apiBase = (apiBase || env.WORKLOG_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
    this.tokenProvider = tokenProvider;
    this.cache = {}; // "owner/repo#12" -> { etag, fetchedAt, data, error }
    this.inflight = new Map();
    this.rateLimitedUntil = 0;
    this.loaded = false;
    this.saveTimer = null;
  }

  async token() {
    if (this._token === undefined) {
      this._token = this.env.GITHUB_TOKEN || this.env.GH_TOKEN || (this.env.WORKLOG_GITHUB_NO_GH === '1' ? null : await this.tokenProvider());
    }
    return this._token;
  }

  async status() {
    return { authenticated: Boolean(await this.token()), rateLimitedUntil: this.rateLimitedUntil || null };
  }

  async load() {
    if (this.loaded) return;
    try {
      this.cache = JSON.parse(await readFile(this.file, 'utf8')) || {};
    } catch {
      this.cache = {};
    }
    this.loaded = true;
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save().catch(() => {}), 200);
    this.saveTimer.unref?.();
  }

  async save() {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.cache));
    await rename(tmp, this.file);
  }

  async request(method, url, { body, etag } = {}) {
    const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'work-log' };
    const token = await this.token();
    if (token) headers.authorization = `Bearer ${token}`;
    if (etag) headers['if-none-match'] = etag;
    if (body) headers['content-type'] = 'application/json';
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
      if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
        this.rateLimitedUntil = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000 || Date.now() + 60 * 1000;
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  fresh(entry, now) {
    if (!entry) return false;
    const ttl = entry.error ? ERROR_TTL_MS : entry.data?.state === 'open' ? OPEN_TTL_MS : CLOSED_TTL_MS;
    return now - entry.fetchedAt < ttl;
  }

  // 1件取得。キャッシュが新しければそれを返す
  async get(repo, number, { now = Date.now(), force = false } = {}) {
    await this.load();
    if (!REPO_RE.test(repo) || !Number.isInteger(number)) return null;
    const key = `${repo}#${number}`;
    const entry = this.cache[key];
    if (!force && this.fresh(entry, now)) return entry;
    if (now < this.rateLimitedUntil) return entry || { error: 'rate_limited', fetchedAt: now };
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try {
        const res = await this.request('GET', `${this.apiBase}/repos/${repo}/issues/${number}`, { etag: entry?.etag });
        if (res.status === 304 && entry) {
          this.cache[key] = { ...entry, fetchedAt: now };
        } else if (res.ok) {
          this.cache[key] = { etag: res.headers.get('etag'), fetchedAt: now, data: pickIssue(await res.json()) };
        } else {
          const error = res.status === 404 ? 'not_found' : now < this.rateLimitedUntil ? 'rate_limited' : `http_${res.status}`;
          // 取れなかったときも、以前取れた内容は残す
          this.cache[key] = { ...(entry || {}), error, fetchedAt: now };
        }
      } catch (err) {
        return entry || { error: err.name === 'AbortError' ? 'timeout' : 'network', fetchedAt: now };
      } finally {
        this.inflight.delete(key);
      }
      this.scheduleSave();
      return this.cache[key];
    })();
    this.inflight.set(key, p);
    return p;
  }

  // まとめて取得(同時に CONCURRENCY 件まで)。waitMs を過ぎたら、その時点で分かっている内容で返す(取得は裏で続く)
  async getMany(refs, { waitMs = 2500, onUpdate } = {}) {
    await this.load();
    const uniq = [...new Map(refs.filter((r) => r.repo && r.number).map((r) => [`${r.repo}#${r.number}`, r])).values()];
    const queue = [...uniq];
    let changed = false;
    const worker = async () => {
      while (queue.length) {
        const r = queue.shift();
        const before = this.cache[`${r.repo}#${r.number}`]?.fetchedAt;
        const after = await this.get(r.repo, r.number);
        if (after?.fetchedAt !== before) changed = true;
      }
    };
    const all = Promise.all(Array.from({ length: Math.min(CONCURRENCY, uniq.length) }, worker));
    const timedOut = await Promise.race([all.then(() => false), new Promise((r) => setTimeout(() => r(true), waitMs).unref?.())]);
    if (timedOut) all.then(() => changed && onUpdate?.());
    return Object.fromEntries(uniq.map((r) => [`${r.repo}#${r.number}`, this.cache[`${r.repo}#${r.number}`] || null]));
  }

  async comment(repo, number, body) {
    if (!REPO_RE.test(repo) || !Number.isInteger(number)) throw new Error('issue の指定が不正です');
    if (!(await this.token())) throw new Error('コメントの投稿には GitHub のトークンが必要です(GITHUB_TOKEN か gh auth login)');
    const res = await this.request('POST', `${this.apiBase}/repos/${repo}/issues/${number}/comments`, { body: { body } });
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status}: ${msg.slice(0, 200)}`);
    }
    const j = await res.json();
    // コメント数が変わるので次回は取り直す
    const key = `${repo}#${number}`;
    if (this.cache[key]) this.cache[key].fetchedAt = 0;
    return { url: j.html_url };
  }
}
