// 記録先(カレンダー・工数管理サービス)の共通部分: 設定、HTTP の送り方(10秒で打ち切り・リダイレクトしない・
// 429 は待ち時間を添えてエラーにする)、続けて送るときの間隔。
// 各サービスは configured / destination / payload / create / update / remove を実装する。
// 認証情報はサーバー側だけで使い、status() には含めない。
const TIMEOUT_MS = 10000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SyncClient {
  // name: 記録先の名前(sync/index.js の SYNCS)/ minIntervalMs: 続けて送るときの最小の間隔
  constructor({ name, label, defaultBase, env = process.env, fetchImpl = fetch, config = {}, minIntervalMs = 0 } = {}) {
    this.name = name;
    this.label = label;
    this.env = env;
    this.fetch = fetchImpl;
    this.minIntervalMs = minIntervalMs;
    this.lastAt = 0;
    // テスト用に API の場所を差し替えられる(WORKLOG_<NAME>_API)
    this.base = (env[`WORKLOG_${name.toUpperCase()}_API`] || defaultBase).replace(/\/+$/, '');
    this.setConfig(config);
  }

  setConfig(cfg = {}) {
    this.cfg = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  }

  // 以下はサービスごとに実装する
  configured() {
    return false;
  }
  destination() {
    return null;
  }
  missing() {
    return []; // 足りない設定(環境変数・config.json のキー)の名前
  }
  payload(entry, ctx) {
    throw new Error('not implemented');
  }
  async create(entry, ctx) {
    throw new Error('not implemented');
  }
  async update(id, entry, ctx) {
    throw new Error('not implemented');
  }
  async remove(id) {
    throw new Error('not implemented');
  }

  // セッションを区間ごとに分けず1件にまとめるか / これより短いものは記録しない(分)
  options() {
    const min = Number(this.cfg.minMinutes);
    return { mergeSegments: Boolean(this.cfg.mergeSegments), minMinutes: Number.isFinite(min) && min >= 0 ? min : 1 };
  }

  status() {
    const configured = this.configured();
    return { configured, destination: configured ? this.destination() : null, missing: configured ? [] : this.missing(), ...this.options() };
  }

  // 応答をそのまま返す(JSON 以外の API 用。CalDAV など)。429 だけはここでエラーにする
  async send(method, url, { headers = {}, body } = {}) {
    const wait = this.lastAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await this.fetch(url, { method, headers, body, redirect: 'error', signal: ac.signal });
    } catch (err) {
      throw new Error(`${this.label} に接続できません: ${err.name === 'AbortError' ? '応答がありません(10秒)' : err.message}`);
    } finally {
      clearTimeout(timer);
      this.lastAt = Date.now();
    }
    if (res.status === 429) {
      await res.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`${this.label} の API の利用制限に達しました(${res.headers.get('retry-after') || '少し'}秒後に再試行してください)`), { status: 429, retryAfter: res.headers.get('retry-after') });
    }
    return res;
  }

  // JSON の API を呼ぶ。404 / 410 は err.status で見分けられるようにする
  async request(method, url, { headers = {}, body, form } = {}) {
    const res = await this.send(method, url, {
      headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
      body: form ? new URLSearchParams(form).toString() : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // JSON でない応答(Toggl はエラーを文字列で返すことがある)
    }
    if (!res.ok) {
      const detail = json ? json.error?.message || json.error_description || json.error || json.message || '' : text;
      throw Object.assign(new Error(`${this.label} ${res.status}: ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 200)}`), { status: res.status, body: json });
    }
    return json;
  }
}

// 秒の端数を落とした UTC の日時(2026-10-04T01:02:03Z)
export const isoSeconds = (v) => new Date(v).toISOString().replace(/\.\d{3}Z$/, 'Z');
