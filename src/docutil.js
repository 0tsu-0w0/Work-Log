// ドキュメント系の送り先(Confluence / esa / Qiita Team)で共通の部品。
//   PageMap: 期間(day:2026-10-04 など)→ 相手側のページの ID を覚えておくファイル。同じ期間をもう一度送ると、新しいページを作らず同じページを更新する
//   request: 10秒のタイムアウト付きの fetch(リダイレクトは追わない)
//   upsert : 覚えているページがあれば更新し、無い・相手側で消えていれば作る
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

export const TIMEOUT_MS = 10000;

export class PageMap {
  // file が無いときは、このプロセスの間だけ覚える
  constructor(file = null) {
    this.file = file;
    this.mem = null;
  }

  async load() {
    if (this.mem) return this.mem;
    let data = {};
    if (this.file) {
      try {
        data = JSON.parse(await readFile(this.file, 'utf8'));
      } catch {
        data = {};
      }
    }
    this.mem = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    return this.mem;
  }

  async get(key) {
    const m = await this.load();
    return Object.hasOwn(m, key) ? m[key] : null;
  }

  async set(key, value) {
    const m = await this.load();
    m[key] = { ...value, savedAt: new Date().toISOString() };
    if (!this.file) return;
    // 覚えておけなくても、送った結果は返す(次回は新しいページができてしまうので警告だけ出す)
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(m));
      await rename(tmp, this.file);
    } catch (err) {
      console.warn(`[work-log] ${this.file} を書けません: ${err.message}`);
    }
  }
}

export async function request(fetchImpl, url, init, label) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { redirect: 'error', signal: ac.signal, ...init });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`${label} への接続がタイムアウトしました`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// JSON として読めなければ null
export const jsonOf = (res) => res.json().catch(() => null);

// update(hit) は更新した結果を返し、相手側にページが無ければ null を返す。create() は作った結果を返す。
// どちらも { id, url, ... } を返す。結果は key で覚える
export async function upsert(map, key, { update, create }) {
  const hit = await map.get(key);
  if (hit?.id != null) {
    const r = await update(hit);
    if (r) {
      await map.set(key, r);
      return { url: r.url || null, updated: true };
    }
  }
  const r = await create();
  await map.set(key, r);
  return { url: r.url || null, updated: false };
}

// message が日報・週報のものか(期間の指定が正しいか)
export function periodKey(message, label) {
  if (!message || message.kind !== 'report' || !['day', 'week'].includes(message.period) || !/^\d{4}-\d{2}-\d{2}$/.test(message.start || '')) {
    throw new Error(`${label} に送れるのは日報・週報だけです`);
  }
  return `${message.period}:${message.start}`;
}
