// セッションの収集と、解析結果・要約のJSONキャッシュ。
// 変更のあったファイル(mtime/size が変わったもの)だけを再解析する。
import { readdir, stat, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { defaultPaths } from './paths.js';
import { parseSessionFile } from './parser.js';
import { heuristicSummary } from './tagger.js';
import { summarize } from './summarizer.js';
import { HookLog, deriveStatus } from './live.js';
import { sessionGit } from './git.js';

// Git の情報は外部(手作業のコミットなど)でも変わるので、短時間だけ使い回す
const GIT_CACHE_MS = 60 * 1000;

const CACHE_VERSION = 2; // 解析結果の形が変わったら上げる(古いキャッシュを捨てて再解析させる)

export { defaultPaths };

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

// 要約の再生成が必要かどうかを判定するための指紋
export function fingerprint(session) {
  return `${session.end}|${session.messageCount}`;
}

export class Store {
  constructor({ projectsDir, cacheDir } = defaultPaths()) {
    this.projectsDir = projectsDir;
    this.cacheDir = cacheDir;
    this.hooks = new HookLog(cacheDir);
    this.cacheFile = path.join(cacheDir, 'sessions.json');
    this.summaryFile = path.join(cacheDir, 'summaries.json');
    this.files = {}; // file -> { mtimeMs, size, session }
    this.summaries = {}; // sessionId -> { fingerprint, ...summary }
    this.loaded = false;
    this.scanning = null;
    this.gitCache = new Map(); // sessionId -> { key, at, promise }
  }

  async load() {
    const cache = await readJson(this.cacheFile, null);
    if (cache?.version === CACHE_VERSION) this.files = cache.files || {};
    this.summaries = (await readJson(this.summaryFile, {})) || {};
    this.loaded = true;
  }

  async listLogFiles() {
    let dirs;
    try {
      dirs = await readdir(this.projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(this.projectsDir, d.name);
      let entries = [];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of entries) if (f.isFile() && f.name.endsWith('.jsonl')) out.push({ file: path.join(dir, f.name), projectDir: dir });
    }
    return out;
  }

  // 同時に複数回呼ばれても実際のスキャンは1本にまとめる。
  // 実行中に呼ばれたら、その後にもう1回だけ走らせる(実行中に届いたフック通知を取りこぼさないため)
  scan() {
    if (this.scanning) {
      this.rescan ||= this.scanning.then(() => {
        this.rescan = null;
        return this.scan();
      });
      return this.rescan;
    }
    this.scanning = this._scan().finally(() => (this.scanning = null));
    return this.scanning;
  }

  async _scan() {
    if (!this.loaded) await this.load();
    const hookEvents = await this.hooks.ingest().catch((err) => {
      console.warn(`[work-log] フックイベントの取り込みに失敗: ${err.message}`);
      return 0;
    });
    const found = await this.listLogFiles();
    const seen = new Set();
    let changed = 0;
    for (const { file, projectDir } of found) {
      seen.add(file);
      let st;
      try {
        st = await stat(file);
      } catch {
        continue;
      }
      const cached = this.files[file];
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) continue;
      try {
        const session = await parseSessionFile(file, projectDir);
        this.files[file] = { mtimeMs: st.mtimeMs, size: st.size, session };
        changed++;
      } catch (err) {
        console.warn(`[work-log] 解析に失敗: ${file}: ${err.message}`);
      }
    }
    for (const file of Object.keys(this.files)) {
      if (!seen.has(file)) {
        delete this.files[file];
        changed++;
      }
    }
    if (changed) await writeJsonAtomic(this.cacheFile, { version: CACHE_VERSION, files: this.files });
    return { total: found.length, changed, hookEvents };
  }

  rawSessions() {
    return Object.values(this.files)
      .map((f) => f.session)
      .filter((s) => s.start && s.messageCount > 0);
  }

  getRaw(id) {
    return this.rawSessions().find((s) => s.id === id) || null;
  }

  summaryFor(session) {
    const cached = this.summaries[session.id];
    // LLM要約はセッションが伸びても古い要約を表示し続け、再生成は明示操作時のみ
    if (cached && (cached.fingerprint === fingerprint(session) || cached.source === 'llm')) {
      return { ...cached, stale: cached.fingerprint !== fingerprint(session) };
    }
    return { ...heuristicSummary(session), stale: false };
  }

  view(session, now = Date.now()) {
    const sum = this.summaryFor(session);
    const hook = this.hooks.get(session.id);
    return {
      ...session,
      status: deriveStatus(hook, session.end, now),
      hook: hook && { startedAt: hook.startedAt, source: hook.source, endedAt: hook.endedAt, endReason: hook.endReason, lastEvent: hook.lastEvent, lastEventAt: hook.lastEventAt },
      displayTitle: sum.title || session.title,
      summary: sum.summary,
      summarySource: sum.source,
      summaryStale: sum.stale,
      workType: sum.workType,
      components: sum.components || [],
    };
  }

  sessions(now = Date.now()) {
    return this.rawSessions()
      .map((s) => this.view(s, now))
      .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  }

  async gitFor(id, { now = Date.now() } = {}) {
    const raw = this.getRaw(id);
    if (!raw) return null;
    const session = this.view(raw, now);
    const key = `${fingerprint(session)}|${session.status}`;
    const hit = this.gitCache.get(id);
    if (hit && hit.key === key && now - hit.at < GIT_CACHE_MS) return hit.promise;
    const promise = sessionGit(session, { now }).catch((err) => ({ available: false, reason: 'error', error: err.message }));
    this.gitCache.set(id, { key, at: now, promise });
    return promise;
  }

  // 同じ内容のセッションは再要約しない(force 指定時を除く)
  async summarize(id, { force = false, env = process.env, fetchImpl } = {}) {
    const session = this.getRaw(id);
    if (!session) throw new Error(`セッションが見つかりません: ${id}`);
    const fp = fingerprint(session);
    const cached = this.summaries[id];
    if (!force && cached?.source === 'llm' && cached.fingerprint === fp) return this.view(session);
    const result = await summarize(session, { useLlm: true, env, fetchImpl });
    this.summaries[id] = { ...result, fingerprint: fp, createdAt: new Date().toISOString() };
    await writeJsonAtomic(this.summaryFile, this.summaries);
    return this.view(session);
  }
}
