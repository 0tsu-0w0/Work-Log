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
import { extractTaskRefs, normalizeConfig, refsFromText, resolveRef, repoInfoOf } from './tasks.js';
import { Trackers } from './trackers/index.js';
import { buildWorkLog } from './worklog.js';
import { DESTINATIONS, DEST_BY_NAME } from './destinations.js';
import { SOURCES } from './sources.js';
import { periodRange, buildReport, validTimeZone, todayIn } from './report.js';
import { remoteWebBase, webBaseFromRemote } from './git.js';
import { filterSessions } from './filter.js';
import { mask, maskDeep } from './mask.js';
import { createHash } from 'node:crypto';
import { Syncs } from './sync/index.js';
import { resolveRange } from './sync/entries.js';
import { buildCalendar } from './ical.js';
import { exportRows, toCsv, toXlsx } from './export.js';
import { buildMetrics } from './metrics.js';

// Git の情報は外部(手作業のコミットなど)でも変わるので、短時間だけ使い回す
const GIT_CACHE_MS = 60 * 1000;

const CACHE_VERSION = 6; // 解析結果の形が変わったら上げる(古いキャッシュを捨てて再解析させる)

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
  // sourceDirs: { codex: dir, ... }(Claude Code 以外のログの場所。省いた取り込み元は読まない)
  // destinations: { slack: client, ... }(省いた送り先は環境変数から作る。作るときは { cacheDir } を渡す)。slack / discord / teams / googleChat は個別に渡してもよい
  // syncs: { toggl: client, ... }(カレンダー・工数管理サービスへの記録。省いた記録先は環境変数から作る)
  constructor({ projectsDir, cacheDir, codexDir = null, sourceDirs = {}, github = null, destinations = {}, slack = null, discord = null, teams = null, googleChat = null, syncs = {} } = defaultPaths()) {
    const given = { slack, discord, teams, googlechat: googleChat, ...destinations };
    this.destinations = Object.fromEntries(DESTINATIONS.map((d) => [d.name, given[d.name] || new d.Client({ cacheDir })]));
    this.slack = this.destinations.slack;
    this.discord = this.destinations.discord;
    this.teams = this.destinations.teams;
    this.googleChat = this.destinations.googlechat;
    this.sourceDirs = Object.fromEntries(Object.entries({ ...(codexDir ? { codex: codexDir } : {}), ...sourceDirs }).filter(([, d]) => d));
    this.slackNotifiedFile = path.join(cacheDir, 'slack-notified.json');
    this.trackers = new Trackers({ cacheDir, github });
    this.github = this.trackers.github;
    this.projectsDir = projectsDir;
    this.codexDir = this.sourceDirs.codex || null;
    this.cacheDir = cacheDir;
    this.hooks = new HookLog(cacheDir);
    this.cacheFile = path.join(cacheDir, 'sessions.json');
    this.summaryFile = path.join(cacheDir, 'summaries.json');
    this.files = {}; // file -> { mtimeMs, size, session }
    this.summaries = {}; // sessionId -> { fingerprint, ...summary }
    this.loaded = false;
    this.scanning = null;
    this.gitCache = new Map(); // sessionId -> { key, at, promise }
    this.taskCfg = normalizeConfig();
    this.links = {}; // sessionId -> { add: [ref], remove: [id] }(画面から手で付け外ししたタスク)
    this.linksFile = path.join(cacheDir, 'links.json');
    this.remotes = new Map(); // cwd -> { at, promise }
    this.syncs = new Syncs({ cacheDir, clients: syncs });
  }

  // 設定(任意): ~/.work-log/config.json。今はタスクIDの拾い方とリンク先だけ
  async loadConfig() {
    const file = path.join(this.cacheDir, 'config.json');
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[work-log] ${file} を読めません: ${err.message}`);
    }
    if (text === this.configText) return; // 変わっていなければ作り直さない(取得中の状態やキャッシュを保つ)
    this.configText = text;
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch (err) {
      console.warn(`[work-log] ${file} を読めません: ${err.message}`);
    }
    this.taskCfg = normalizeConfig(json);
    this.trackers.setConfig(json.tasks || {});
    for (const d of DESTINATIONS) this.destinations[d.name].setConfig(json[d.name] || {});
    this.syncs.setConfig(json);
    this.remoteCfg = json?.remote && typeof json.remote === 'object' ? json.remote : {}; // Tailscale 経由で開くときの名前と利用者(remote.js)
    this.metricsEnabled = json?.metrics?.enabled === true; // /metrics(Prometheus 形式)を出すか。環境変数 WORKLOG_METRICS=1 でもよい
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

  // Claude Code 以外のツールのログ(sources.js の取り込み元ごと)
  async listSourceFiles() {
    const out = [];
    for (const src of SOURCES) {
      const dir = this.sourceDirs[src.name];
      if (!dir) continue;
      try {
        for (const f of await src.list(dir)) out.push({ ...f, tool: src.name });
      } catch (err) {
        console.warn(`[work-log] ${src.label} のログを探せません: ${err.message}`);
      }
    }
    return out;
  }

  async load() {
    const cache = await readJson(this.cacheFile, null);
    if (cache?.version === CACHE_VERSION) this.files = cache.files || {};
    this.summaries = (await readJson(this.summaryFile, {})) || {};
    this.links = (await readJson(this.linksFile, {})) || {};
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
    await this.loadConfig();
    const found = [...(await this.listLogFiles()), ...(await this.listSourceFiles())];
    const seen = new Set();
    let changed = 0;
    for (const entry of found) {
      const { file, projectDir, parentId, tool } = entry;
      seen.add(file);
      let st;
      try {
        // 取り込み元によっては file が仮想のキー(DB の中のチャットなど)で、更新時刻とサイズを自分で持つ
        st = Number.isFinite(entry.mtimeMs) ? { mtimeMs: entry.mtimeMs, size: entry.size ?? 0 } : await stat(entry.statFile || file);
      } catch {
        continue;
      }
      const cached = this.files[file];
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) continue;
      try {
        const src = tool && tool !== 'claude' ? SOURCES.find((s) => s.name === tool) : null;
        const session = src ? await src.parse(file, entry) : await parseSessionFile(file, projectDir);
        if (src) session.tool = src.name;
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
      tasks: this.taskRefsOf(session),
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

  // 自動で見つけたタスク + 手で付けたタスク - 手で外したタスク(リポジトリ未解決の状態)
  taskRefsOf(session) {
    const link = this.links[session.id] || {};
    const removed = new Set(link.remove || []);
    const map = new Map();
    for (const r of extractTaskRefs(session, this.taskCfg)) if (!removed.has(r.id)) map.set(r.id, r);
    for (const r of link.add || []) map.set(r.id, { ...r, sources: ['manual'] });
    return [...map.values()];
  }

  remoteFor(cwd, now = Date.now()) {
    const hit = this.remotes.get(cwd);
    if (hit && now - hit.at < 10 * 60 * 1000) return hit.promise;
    const promise = remoteWebBase(cwd);
    this.remotes.set(cwd, { at: now, promise });
    return promise;
  }

  // "#123" をセッションのリポジトリの issue に解決し、リンク先URLを付ける
  async resolvedTasks(session, { enrich = false, ...opts } = {}) {
    if (!session.tasks.length) return [];
    if (enrich) return this.enrichTasks(await this.resolvedTasks(session), opts);
    let repoInfo = repoInfoOf(webBaseFromRemote(session.repoUrl));
    if (!repoInfo && session.tasks.some((t) => t.kind === 'github')) repoInfo = repoInfoOf(await this.remoteFor(session.cwd));
    // URL と "#123" のように別の書き方で同じ課題を指していたら1つにまとめる(時間を二重に数えないため)
    const byId = new Map();
    for (const r of session.tasks.map((t) => resolveRef(t, { repoInfo, cfg: this.taskCfg, trackers: this.trackers, project: session.project })).filter(Boolean)) {
      const cur = byId.get(r.id);
      if (!cur) byId.set(r.id, r);
      else byId.set(r.id, { ...cur, url: cur.url || r.url, sources: [...new Set([...(cur.sources || []), ...(r.sources || [])])] });
    }
    return [...byId.values()];
  }

  // 課題(GitHub / GitLab / Linear / Jira / Backlog / Notion / Redmine / Gitea)のタイトル・状態・ラベルなどを付ける(取れなければ付けない)
  async enrichTasks(tasks, opts = {}) {
    return this.trackers.enrich(tasks, opts);
  }

  // 期間内に動いたセッションをタスクごとにまとめる(時間・コスト・コミットはセッション全体の値)
  async tasks(params = {}, opts = {}) {
    const list = await this.taskSummaries(params);
    return this.enrichTasks(list, opts);
  }

  // 課題に投稿する作業記録。書式はサービスに合わせ(Markdown / Jira 記法 / プレーンテキスト)、秘匿情報はマスキングする
  async issueComment(taskId, { timeZone } = {}) {
    const t = (await this.taskSummaries({})).find((x) => x.id === taskId);
    if (!t) throw new Error(`タスクが見つかりません: ${taskId}`);
    const provider = t.provider && this.trackers.get(t.provider);
    if (!provider || !provider.valid(t)) throw new Error('連携しているサービス(GitHub / GitLab / Linear / Jira / Backlog / Notion / Redmine / Gitea)の課題に解決できたタスクだけにコメントできます');
    const sessions = [...t.sessions].reverse().map((s) => ({ ...s, hashes: (this.getRaw(s.id)?.commitList || []).map((c) => c.hash) }));
    // 秘匿情報は書式を整える前にも伏せる(記号を逃がした後では見つけられないことがあるため)
    const body = mask(buildWorkLog(maskDeep({ ...t, sessions }), { format: provider.commentFormat(), timeZone }));
    return {
      provider: provider.name,
      providerLabel: provider.label,
      target: t.label || t.id,
      authenticated: await provider.authenticated(),
      body,
      hash: createHash('sha256').update(`${provider.name}\n${body}`).digest('hex').slice(0, 16),
      ref: { id: t.id, repo: t.repo, number: t.number, mr: t.mr, pageId: t.pageId },
    };
  }

  destination(target) {
    const name = Object.hasOwn(DEST_BY_NAME, target) ? target : 'slack';
    return { name, dest: this.destinations[name], fmt: DEST_BY_NAME[name] };
  }

  // 日報・週報。params: { target: 送り先の名前(destinations.js), period: 'day' | 'week', date: 'YYYY-MM-DD', tz }
  async report({ target = 'slack', period = 'day', date, tz, waitMs = 1500 } = {}) {
    const { name, dest, fmt } = this.destination(target);
    const timeZone = validTimeZone(tz);
    const range = periodRange({ period: period === 'week' ? 'week' : 'day', date: date || todayIn(timeZone), timeZone });
    const from = new Date(range.from).toISOString();
    const to = new Date(range.to).toISOString();
    const sessions = filterSessions(this.sessions(), { from, to });
    const tasks = await this.tasks({ from, to }, { waitMs });
    const data = buildReport({ sessions, tasks, costs: this.costs({ from, to }), range });
    const st = dest.status();
    // 秘匿情報は書式を整える前に伏せる(Discord の Markdown の記号を逃がすと "ghp_…" が "ghp\_…" になり、後からでは見つけられない)
    const { preview, ...message } = fmt.report(maskDeep(data), { includeCost: st.includeCost, maxSessions: Number(dest.cfg.maxSessions) || fmt.maxSessions || 20 });
    const masked = maskDeep(message);
    return { target: name, message: masked, preview: mask(preview), range, totals: data.totals, status: st, hash: createHash('sha256').update(`${name}\n${JSON.stringify(masked)}`).digest('hex').slice(0, 16) };
  }

  // プレビューと同じ内容のときだけ送る
  async postReport(params, hash) {
    const r = await this.report(params);
    if (r.hash !== hash) throw Object.assign(new Error('プレビューの後に内容が変わりました。もう一度確認してください'), { status: 409 });
    return this.destinations[r.target].post(r.message);
  }

  // カレンダー(.ics)の書き出し。from / to は "YYYY-MM-DD" か ISO 8601(省くと過去30日)。文字列は伏せてから書き出す
  calendar({ from, to, tz, now = Date.now() } = {}) {
    const range = resolveRange({ from, to }, { timeZone: validTimeZone(tz), defaultDays: 30, maxDays: 366, now });
    return { ...range, ics: buildCalendar(this.sessions(now), { ...range, now }) };
  }

  // 表計算ソフト向けの書き出し。format: "csv" | "xlsx" / unit: "segment"(区間ごと。既定)| "session"(セッションごと)
  // from / to は "YYYY-MM-DD" か ISO 8601(省くと過去30日、最大366日)。文字列は伏せてから書き出す
  spreadsheet({ format = 'csv', from, to, tz, unit = 'segment', now = Date.now() } = {}) {
    if (!['csv', 'xlsx'].includes(format)) throw new Error(`形式は csv か xlsx です: ${String(format).slice(0, 20)}`);
    if (!['segment', 'session'].includes(unit)) throw new Error(`unit は segment(区間ごと)か session(セッションごと)です: ${String(unit).slice(0, 20)}`);
    const timeZone = validTimeZone(tz);
    const range = resolveRange({ from, to }, { timeZone, defaultDays: 30, maxDays: 366, now });
    const rows = exportRows(this.sessions(now), { ...range, unit, subagents: this.subagentIndex() });
    const body = format === 'csv' ? toCsv(rows, { timeZone }) : toXlsx(rows, { timeZone, now });
    return { ...range, timeZone, rows: rows.length, body };
  }

  // Prometheus のテキスト形式の指標(手元に残っているログ全体の累計)
  metrics(now = Date.now()) {
    return buildMetrics({ sessions: this.sessions(now), costs: this.costs() });
  }

  // カレンダー・工数管理サービスへの記録の下見。終わったセッションだけが対象。params: { from, to, tz }(省くと過去7日)
  async sync(target, { from, to, tz, now = Date.now() } = {}) {
    if (!this.loaded) await this.load();
    const range = resolveRange({ from, to }, { timeZone: validTimeZone(tz), defaultDays: 7, maxDays: 93, now });
    let sessions = this.sessions(now);
    // 課題に紐付けて記録する記録先(Redmine の作業時間・Jira の作業ログ)には、期間に入るセッションの課題を解決して渡す
    if (this.syncs.usesTasks(target)) sessions = await Promise.all(sessions.map(async (s) => (Date.parse(s.end) >= range.from ? { ...s, linkedTasks: await this.resolvedTasks(s) } : s)));
    const plan = await this.syncs.plan(target, sessions, { ...range, now });
    return { ...plan, previewText: this.syncs.previewText(plan, validTimeZone(tz || plan.timeZone)) };
  }

  // 下見と同じ内容のときだけ記録する(見せた内容と違うものを送らないため)
  async postSync({ target, ...params } = {}, hash) {
    return this.syncs.exclusive(String(target), async () => {
      const plan = await this.sync(target, params);
      if (plan.hash !== hash) throw Object.assign(new Error('プレビューの後に内容が変わりました。もう一度確認してください'), { status: 409 });
      return { target: plan.target, ...(await this.syncs.apply(plan.target, plan)) };
    });
  }

  // セッション終了の通知(config.json の slack.notify / discord.notify が "session_end" のとき)。hooks の SessionEnd を受けたセッションが対象。
  // 古い終了まで一度に送らないよう、終了から2時間以内のものだけ送る。送ったものは記録して二度送らない
  async notifySessionEnds(now = Date.now()) {
    const targets = Object.entries(this.destinations).filter(([name, d]) => DEST_BY_NAME[name].sessionEnd && d.status().notify === 'session_end' && d.status().configured);
    if (!targets.length) return 0;
    const sent = new Set((await readJson(this.slackNotifiedFile, [])) || []);
    const subIdx = this.subagentIndex();
    let count = 0;
    for (const raw of this.rawSessions()) {
      const hook = this.hooks.get(raw.id);
      if (hook?.lastEvent !== 'SessionEnd' || !hook.endedAt || now - Date.parse(hook.endedAt) > 2 * 60 * 60 * 1000) continue;
      let view = null;
      for (const [name, dest] of targets) {
        // 以前の記録(Slack だけだった頃)は送り先の名前が付いていない
        const key = `${name}:${raw.id}@${hook.endedAt}`;
        if (sent.has(key) || (name === 'slack' && sent.has(`${raw.id}@${hook.endedAt}`))) continue;
        sent.add(key); // 失敗しても繰り返し送らない
        try {
          view ||= await (async () => {
            const v = this.view(raw, now, subIdx);
            return { ...v, tasks: await this.resolvedTasks(v) };
          })();
          const msg = DEST_BY_NAME[name].sessionEnd(maskDeep(view), { includeCost: dest.status().includeCost });
          await dest.post(maskDeep(msg));
          count++;
        } catch (err) {
          console.warn(`[work-log] ${name} への通知に失敗: ${err.message}`);
        }
      }
    }
    await writeJsonAtomic(this.slackNotifiedFile, [...sent].slice(-500));
    return count;
  }

  // プレビューと同じ内容のときだけ投稿する(見せた内容と違うものを投稿しないため)
  async postIssueComment(taskId, hash, opts = {}) {
    const c = await this.issueComment(taskId, opts);
    if (c.hash !== hash) throw Object.assign(new Error('プレビューの後に内容が変わりました。もう一度確認してください'), { status: 409 });
    return this.trackers.get(c.provider).comment(c.ref, c.body);
  }

  async taskSummaries(params = {}) {
    const sessions = filterSessions(this.sessions(), params);
    const byId = new Map();
    for (const s of sessions) {
      for (const t of await this.resolvedTasks(s)) {
        const cur = byId.get(t.id) || { id: t.id, label: t.label, kind: t.kind, provider: t.provider || null, url: t.url || null, repo: t.repo || null, host: t.host || null, number: t.number ?? null, mr: Boolean(t.mr), pageId: t.pageId || null, sources: [], projects: [], sessions: [], activeMs: 0, usd: 0, commits: 0 };
        if (!cur.url && t.url) cur.url = t.url;
        for (const src of t.sources || []) if (!cur.sources.includes(src)) cur.sources.push(src);
        if (!cur.projects.includes(s.project)) cur.projects.push(s.project);
        cur.sessions.push({ id: s.id, title: s.displayTitle, project: s.project, tool: s.tool, start: s.start, end: s.end, activeMs: s.activeMs, usd: s.cost.usd, commits: s.commits });
        cur.activeMs += s.activeMs;
        cur.usd += s.cost.usd;
        cur.commits += s.commits;
        byId.set(t.id, cur);
      }
    }
    const list = [...byId.values()].map((t) => ({
      ...t,
      first: t.sessions.reduce((m, x) => (x.start < m ? x.start : m), t.sessions[0].start),
      last: t.sessions.reduce((m, x) => (x.end > m ? x.end : m), t.sessions[0].end),
      sessions: t.sessions.sort((a, b) => Date.parse(b.start) - Date.parse(a.start)),
    }));
    return list.sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
  }

  // 画面からの付け外し。入力はID・URL・"#123" のいずれでもよい
  async updateLinks(id, { add = [], remove = [] } = {}) {
    const raw = this.getRaw(id);
    if (!raw) throw new Error(`セッションが見つかりません: ${id}`);
    const link = this.links[id] || { add: [], remove: [] };
    for (const input of add) {
      const refs = [...refsFromText(String(input), 'manual', { ...this.taskCfg, keys: null, deny: new Set() }).values()];
      if (!refs.length) throw new Error(`タスクIDとして読めません: ${input}(例: ABC-123、#45、owner/repo#45、課題のURL)`);
      for (const r of refs) {
        link.add = [...link.add.filter((x) => x.id !== r.id), { id: r.id, kind: r.kind, repo: r.repo, number: r.number, url: r.url }];
        link.remove = link.remove.filter((x) => x !== r.id);
      }
    }
    for (const rid of remove) {
      link.add = link.add.filter((x) => x.id !== rid);
      if (!link.remove.includes(rid)) link.remove.push(rid);
    }
    this.links[id] = link;
    await writeJsonAtomic(this.linksFile, this.links);
    return this.view(raw);
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
