// セッションの収集と、解析結果・要約のJSONキャッシュ。
// 変更のあったファイル(mtime/size が変わったもの)だけを再解析する。
import { readdir, stat, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseSessionFile } from './parser.js';
import { heuristicSummary } from './tagger.js';
import { summarize } from './summarizer.js';

const CACHE_VERSION = 1;
// 最終アクティビティからこの時間以内なら「進行中」とみなす
export const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

export function defaultPaths(env = process.env) {
  const home = os.homedir();
  return {
    projectsDir: env.WORKLOG_PROJECTS_DIR || path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'),
    cacheDir: env.WORKLOG_CACHE_DIR || path.join(home, '.work-log'),
  };
}

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
    this.cacheFile = path.join(cacheDir, 'sessions.json');
    this.summaryFile = path.join(cacheDir, 'summaries.json');
    this.files = {}; // file -> { mtimeMs, size, session }
    this.summaries = {}; // sessionId -> { fingerprint, ...summary }
    this.loaded = false;
    this.scanning = null;
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

  // 同時に複数回呼ばれても実際のスキャンは1本にまとめる
  scan() {
    if (!this.scanning) this.scanning = this._scan().finally(() => (this.scanning = null));
    return this.scanning;
  }

  async _scan() {
    if (!this.loaded) await this.load();
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
    return { total: found.length, changed };
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
    return {
      ...session,
      status: now - Date.parse(session.end) < ACTIVE_WINDOW_MS ? 'active' : 'done',
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
