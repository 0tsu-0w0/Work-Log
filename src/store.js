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
import { costOf, modelFamily, sessionCost, setPricingOverrides } from './pricing.js';
import { parseCodexFile } from './codex.js';

// Git の情報は外部(手作業のコミットなど)でも変わるので、短時間だけ使い回す
const GIT_CACHE_MS = 60 * 1000;

const CACHE_VERSION = 4; // 解析結果の形が変わったら上げる(古いキャッシュを捨てて再解析させる)

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
  constructor({ projectsDir, cacheDir, codexDir = null } = defaultPaths()) {
    this.projectsDir = projectsDir;
    this.codexDir = codexDir;
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

  // 利用者の単価表(任意)。読めなければ組み込みの単価だけを使う
  async loadPricing() {
    const file = path.join(this.cacheDir, 'pricing.json');
    try {
      setPricingOverrides(JSON.parse(await readFile(file, 'utf8')));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[work-log] ${file} を読めません: ${err.message}`);
      setPricingOverrides({});
    }
  }

  // Codex のログ: <codexDir>/sessions/YYYY/MM/DD/rollout-*.jsonl(.zst) と archived_sessions/
  async listCodexFiles() {
    if (!this.codexDir) return [];
    const out = [];
    const walk = async (dir, depth) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 4) await walk(p, depth + 1);
        else if (e.isFile() && /^rollout-.*\.jsonl(\.zst)?$/.test(e.name)) out.push({ file: p, tool: 'codex' });
      }
    };
    await walk(path.join(this.codexDir, 'sessions'), 0);
    await walk(path.join(this.codexDir, 'archived_sessions'), 0);
    // 圧縮済みと未圧縮が両方あるときは未圧縮(書き込み中の可能性がある方)を使う
    const plain = new Set(out.filter((f) => !f.file.endsWith('.zst')).map((f) => f.file));
    return out.filter((f) => !(f.file.endsWith('.zst') && plain.has(f.file.slice(0, -4))));
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
      for (const f of entries) {
        if (f.isFile() && f.name.endsWith('.jsonl')) out.push({ file: path.join(dir, f.name), projectDir: dir });
        // サブエージェントのログは <セッションID>/subagents/*.jsonl にある。利用量(コスト)だけ親セッションに合算する
        if (f.isDirectory()) {
          const sub = path.join(dir, f.name, 'subagents');
          let subs = [];
          try {
            subs = await readdir(sub, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const g of subs) {
            if (g.isFile() && g.name.endsWith('.jsonl')) out.push({ file: path.join(sub, g.name), projectDir: dir, parentId: f.name });
          }
        }
      }
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
    await this.loadPricing();
    const found = [...(await this.listLogFiles()), ...(await this.listCodexFiles())];
    const seen = new Set();
    let changed = 0;
    for (const { file, projectDir, parentId, tool } of found) {
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
        const session = tool === 'codex' ? await parseCodexFile(file) : await parseSessionFile(file, projectDir);
        session.tool ||= 'claude';
        if (parentId) session.parentId = parentId;
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
      .filter((s) => !s.parentId && s.start && s.messageCount > 0);
  }

  // 親セッションID -> サブエージェントの解析結果
  subagentIndex() {
    const idx = new Map();
    for (const { session } of Object.values(this.files)) {
      if (!session.parentId) continue;
      if (!idx.has(session.parentId)) idx.set(session.parentId, []);
      idx.get(session.parentId).push(session);
    }
    return idx;
  }

  // 期間内のコストを、時間・モデル・プロジェクト単位で集計する(サブエージェントは親のプロジェクトに含める)
  costs({ from, to, project, tool } = {}) {
    const fromKey = from ? new Date(from).toISOString().slice(0, 13) : '';
    const toKey = to ? new Date(to).toISOString().slice(0, 13) : '\uffff';
    const parents = new Map(this.rawSessions().map((x) => [x.id, x]));
    const buckets = new Map();
    const perSession = new Map();
    const unknownModels = new Set();
    let estimated = false;
    for (const { session } of Object.values(this.files)) {
      const owner = session.parentId ? parents.get(session.parentId) : session;
      if (!owner || (project && owner.project !== project)) continue;
      if (tool && (owner.tool || 'claude') !== tool) continue;
      for (const [key, tokens] of Object.entries(session.usage || {})) {
        const [hour, model, fast, us] = key.split('|');
        if (hour < fromKey || hour >= toKey) continue;
        if (session.estimatedOutputTokens) estimated = true;
        const usd = costOf(model, tokens, { fast: fast === 'fast', us: us === 'us' });
        if (usd === null) unknownModels.add(model);
        const bkey = `${hour}|${model}|${owner.project}`;
        const b = buckets.get(bkey) || { hour, model, family: modelFamily(model), project: owner.project, tool: owner.tool || 'claude', tokens: [0, 0, 0, 0, 0, 0], usd: 0, priced: usd !== null };
        tokens.forEach((v, i) => (b.tokens[i] += v));
        b.usd += usd || 0;
        buckets.set(bkey, b);
        perSession.set(owner.id, (perSession.get(owner.id) || 0) + (usd || 0));
      }
    }
    const subIdx = this.subagentIndex();
    const top = [...perSession.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, usd]) => {
      const v = this.view(parents.get(id), Date.now(), subIdx);
      return { id, usd, title: v.displayTitle, project: v.project, start: v.start };
    });
    return { buckets: [...buckets.values()], topSessions: top, unknownModels: [...unknownModels], estimated };
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

  view(session, now = Date.now(), subIdx = this.subagentIndex()) {
    const sum = this.summaryFor(session);
    const hook = this.hooks.get(session.id);
    const subs = subIdx.get(session.id) || [];
    const own = sessionCost(session.usage);
    const subCosts = subs.map((x) => sessionCost(x.usage));
    const unknown = new Set([...own.unknownModels, ...subCosts.flatMap((c) => c.unknownModels)]);
    return {
      ...session,
      // API 換算コスト(USD)。サブエージェント分を含む。単価不明のモデル分は含まない
      cost: {
        usd: own.usd + subCosts.reduce((t, c) => t + c.usd, 0),
        subagentUsd: subCosts.reduce((t, c) => t + c.usd, 0),
        subagents: subs.length,
        unknownModels: [...unknown],
        estimatedOutputTokens: (session.estimatedOutputTokens || 0) + subs.reduce((t, x) => t + (x.estimatedOutputTokens || 0), 0),
      },
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
    const subIdx = this.subagentIndex();
    return this.rawSessions()
      .map((s) => this.view(s, now, subIdx))
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
