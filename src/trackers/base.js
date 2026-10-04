// 課題管理サービス連携の共通部分: 取得結果のキャッシュ、再確認の間隔、API 制限中の停止、同時取得数の制御。
// 各サービス(GitHub / GitLab / Linear / Jira / Backlog)は itemKey・valid・fetchItem・comment だけを実装する。
// 認証情報はサーバー側だけで使い、ブラウザには渡さない。
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

const OPEN_TTL_MS = 10 * 60 * 1000; // 進行中の課題は変わりやすいので短め
const CLOSED_TTL_MS = 24 * 60 * 60 * 1000;
const ERROR_TTL_MS = 30 * 60 * 1000; // 見つからない・権限がないものは何度も聞きに行かない
const REQUEST_TIMEOUT_MS = 8000;
const CONCURRENCY = 4;

// 課題の状態を画面の表示用に4つに分ける
export const CATEGORIES = ['open', 'in_progress', 'done', 'canceled'];

export class CachedTracker {
  constructor({ name, label, cacheDir, file, env = process.env, fetchImpl = fetch }) {
    this.name = name;
    this.label = label;
    this.file = path.join(cacheDir, file || `tracker-${name}.json`);
    this.env = env;
    this.fetch = fetchImpl;
    this.cache = {}; // itemKey -> { etag, fetchedAt, data, error }
    this.inflight = new Map();
    this.rateLimitedUntil = 0;
    this.loaded = false;
    this.saveTimer = null;
  }

  // 以下はサービスごとに実装する
  itemKey(ref) {
    throw new Error('not implemented');
  }
  valid(ref) {
    return false;
  }
  configured() {
    return true; // 接続先が決まっているか(Jira の URL など)
  }
  async authenticated() {
    return false;
  }
  async fetchItem(ref, entry, now) {
    throw new Error('not implemented');
  }
  async comment(ref, body) {
    throw new Error(`${this.label} へのコメントには対応していません`);
  }
  commentFormat() {
    return 'markdown';
  }

  async status() {
    return { name: this.name, label: this.label, configured: this.configured(), authenticated: await this.authenticated(), rateLimitedUntil: this.rateLimitedUntil || null };
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

  // タイムアウト付きの HTTP 要求。API 制限に達したら解除時刻まで止める(rateLimitReset で判定を上書きできる)
  async http(method, url, { headers = {}, body, etag } = {}) {
    const h = { 'user-agent': 'work-log', ...headers };
    if (etag) h['if-none-match'] = etag;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetch(url, { method, headers: h, body, signal: ac.signal });
      const reset = this.rateLimitReset(res);
      if (reset) this.rateLimitedUntil = reset;
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  // 既定: 429、または残り回数 0 の 403 を API 制限とみなす
  rateLimitReset(res) {
    const remaining = res.headers.get('x-ratelimit-remaining') ?? res.headers.get('ratelimit-remaining');
    if (res.status === 429 || ((res.status === 403 || res.status === 429) && remaining === '0')) {
      const retry = Number(res.headers.get('retry-after'));
      const reset = Number(res.headers.get('x-ratelimit-reset') || res.headers.get('ratelimit-reset'));
      if (retry) return Date.now() + retry * 1000;
      if (reset) return reset > 1e12 ? reset : reset * 1000; // 秒とミリ秒のどちらも来うる
      return Date.now() + 60 * 1000;
    }
    return 0;
  }

  // HTTP の状態から、取得失敗の理由を決める
  errorOf(res, now) {
    if (res.status === 404) return 'not_found';
    if (res.status === 401 || res.status === 403) return now < this.rateLimitedUntil ? 'rate_limited' : res.status === 401 ? 'unauthorized' : 'forbidden';
    if (res.status === 429) return 'rate_limited';
    return `http_${res.status}`;
  }

  fresh(entry, now) {
    if (!entry) return false;
    const cat = entry.data?.stateCategory;
    const ttl = entry.error ? ERROR_TTL_MS : cat === 'done' || cat === 'canceled' ? CLOSED_TTL_MS : OPEN_TTL_MS;
    return now - entry.fetchedAt < ttl;
  }

  // 1件取得。キャッシュが新しければそれを返し、取れなかったときも以前取れた内容は残す
  async getRef(ref, { now = Date.now(), force = false } = {}) {
    await this.load();
    if (!this.valid(ref)) return null;
    const key = this.itemKey(ref);
    const entry = this.cache[key];
    if (!force && this.fresh(entry, now)) return entry;
    if (now < this.rateLimitedUntil) return entry || { error: 'rate_limited', fetchedAt: now };
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try {
        this.cache[key] = await this.fetchItem(ref, entry, now);
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
    const uniq = [...new Map(refs.filter((r) => this.valid(r)).map((r) => [this.itemKey(r), r])).values()];
    const queue = [...uniq];
    let changed = false;
    const worker = async () => {
      while (queue.length) {
        const r = queue.shift();
        const before = this.cache[this.itemKey(r)]?.fetchedAt;
        const after = await this.getRef(r);
        if (after?.fetchedAt !== before) changed = true;
      }
    };
    const all = Promise.all(Array.from({ length: Math.min(CONCURRENCY, uniq.length) }, worker));
    const timedOut = await Promise.race([all.then(() => false), new Promise((r) => setTimeout(() => r(true), waitMs).unref?.())]);
    if (timedOut) all.then(() => changed && onUpdate?.());
    return Object.fromEntries(uniq.map((r) => [this.itemKey(r), this.cache[this.itemKey(r)] || null]));
  }

  // コメントを投稿したら、次回は取り直す
  invalidate(ref) {
    const e = this.cache[this.itemKey(ref)];
    if (e) e.fetchedAt = 0;
  }
}

// ラベルの色は画面の style 属性に入るので、6桁の16進数以外は捨てる
export function safeColor(c) {
  const v = String(c || '').replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(v) ? v : null;
}
