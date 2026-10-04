// ローカル専用のHTTPサーバー。127.0.0.1 にのみバインドする。
import http from 'node:http';
import { readFile, writeFile, mkdir, watch } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskDeep } from './mask.js';
import { filterSessions } from './filter.js';

export { filterSessions };
import { llmAvailable, DEFAULT_MODEL } from './summarizer.js';
import { SERVER_FILE } from './hook.js';
import { PRICING_AS_OF, PRICING_SOURCE } from './pricing.js';
import { DESTINATIONS, DEST_BY_NAME } from './destinations.js';
import { SOURCES, TOOL_LABELS } from './sources.js';
import { status as hooksStatus, settingsPath } from './install.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const LIST_FIELDS = [
  'id', 'tool', 'project', 'cwd', 'tasks', 'gitBranch', 'displayTitle', 'start', 'end', 'segments', 'activeMs', 'status', 'hook',
  'messageCount', 'commits', 'workType', 'components', 'summarySource', 'cost',
];


async function readBody(req, limit = 64 * 1024) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > limit) throw new Error('too large');
  }
  return data;
}

function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}

export function createServer(store, { env = process.env } = {}) {
  const shouldMask = env.WORKLOG_NO_MASK !== '1';
  const clients = new Set();
  const out = (v) => (shouldMask ? maskDeep(v) : v);

  function send(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    if (req.method === 'GET' && parts[1] === 'config') {
      const hooks = await hooksStatus({ file: settingsPath(env) });
      return send(res, 200, {
        llm: llmAvailable(env),
        model: env.WORKLOG_MODEL || DEFAULT_MODEL,
        masking: shouldMask,
        projectsDir: store.projectsDir,
        codexDir: store.codexDir,
        sources: SOURCES.map((s) => ({ name: s.name, label: s.label, dir: store.sourceDirs[s.name] || null })),
        toolLabels: TOOL_LABELS,
        hooks: { installed: hooks.events, lastEventAt: store.hooks.lastEventAt },
        github: await store.github.status(),
        trackers: await store.trackers.status(),
        // 送り先(URL やトークンは含めない)。slack などのキーは以前の形との互換
        ...Object.fromEntries(DESTINATIONS.map((d) => [d.name, store.destinations[d.name].status()])),
        destinations: DESTINATIONS.map((d) => ({ name: d.name, label: d.label, env: d.env, note: d.note, ...store.destinations[d.name].status() })),
        // カレンダー・工数管理サービスへの記録先(トークンなどは含めない)
        syncs: store.syncs.list(),
      });
    }
    if (req.method === 'GET' && parts[1] === 'sessions' && parts.length === 2) {
      const all = store.sessions();
      const p = Object.fromEntries(url.searchParams);
      const list = filterSessions(all, p).map((s) => pick(s, LIST_FIELDS));
      const projects = [...new Set(all.map((s) => s.project))].sort();
      const tags = [...new Set(all.flatMap((s) => [s.workType, ...s.components]))].filter(Boolean).sort();
      const tools = [...new Set(all.map((s) => s.tool || 'claude'))].sort();
      return send(res, 200, out({ sessions: list, projects, tags, tools }));
    }
    if (req.method === 'GET' && parts[1] === 'tasks') {
      if (parts[2] === 'comment') {
        try {
          const c = await store.issueComment(url.searchParams.get('id'), { timeZone: url.searchParams.get('tz') || undefined });
          const { ref, ...rest } = c;
          return send(res, 200, out(rest));
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
      }
      return send(res, 200, out({ tasks: await store.tasks(Object.fromEntries(url.searchParams), { onUpdate: () => broadcast('update') }) }));
    }
    // issue / PR への作業記録コメントの投稿: { "id": "owner/repo#12", "hash": "<プレビューの hash>" }
    if (req.method === 'POST' && parts[1] === 'tasks' && parts[2] === 'comment') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const r = await store.postIssueComment(String(body.id || ''), String(body.hash || ''), { timeZone: body.tz ? String(body.tz) : undefined });
        broadcast('update');
        return send(res, 200, r);
      } catch (err) {
        return send(res, err.status || 400, { error: err.message });
      }
    }
    // タスクの付け外し: { "add": ["ABC-123", "#45", "<課題のURL>"], "remove": ["ABC-9"] }
    if (req.method === 'POST' && parts[1] === 'sessions' && parts[3] === 'tasks') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return send(res, 400, { error: 'JSON を送ってください' });
      }
      try {
        const v = await store.updateLinks(parts[2], { add: [].concat(body.add || []), remove: [].concat(body.remove || []) });
        broadcast('update');
        return send(res, 200, out({ ...v, tasks: await store.resolvedTasks(v, { enrich: true }) }));
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }
    // 日報・週報: GET でプレビュー、POST { target, period, date, tz, hash } で送信。/api/slack/report は target=slack と同じ
    if ((parts[1] === 'report' && parts.length === 2) || (parts[1] === 'slack' && parts[2] === 'report')) {
      const fixed = parts[1] === 'slack' ? 'slack' : null;
      try {
        if (req.method === 'GET') {
          const r = await store.report({ ...Object.fromEntries(url.searchParams), ...(fixed ? { target: fixed } : {}) });
          const previewText = DEST_BY_NAME[r.target].plain(r.preview);
          return send(res, 200, { target: r.target, preview: r.preview, previewText, hash: r.hash, totals: r.totals, status: r.status, slack: r.status, range: { period: r.range.period, start: r.range.start } });
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          return send(res, 200, await store.postReport({ target: fixed || body.target, period: body.period, date: body.date, tz: body.tz }, String(body.hash || '')));
        }
      } catch (err) {
        return send(res, err.status || 400, { error: err.message });
      }
    }
    // カレンダー(.ics)の書き出し: ?from=&to=(YYYY-MM-DD か ISO 8601。省くと過去30日、最大366日)
    if (req.method === 'GET' && parts[1] === 'calendar.ics' && parts.length === 2) {
      let r;
      try {
        r = store.calendar({ from: url.searchParams.get('from') || undefined, to: url.searchParams.get('to') || undefined, tz: url.searchParams.get('tz') || undefined });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
      const day = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
      res.writeHead(200, {
        'content-type': 'text/calendar; charset=utf-8',
        'content-disposition': `attachment; filename="work-log-${day(r.from)}-${day(r.to - 1)}.ics"`,
        'cache-control': 'no-store',
      });
      return res.end(r.ics);
    }
    // カレンダー・工数管理サービスへの記録: GET ?target=&from=&to=&tz= で下見、POST { target, from, to, tz, hash } で記録
    if (parts[1] === 'sync' && parts.length === 2) {
      try {
        if (req.method === 'GET') {
          const p = Object.fromEntries(url.searchParams);
          const plan = await store.sync(p.target, { from: p.from, to: p.to, tz: p.tz });
          const items = (list) => list.map(({ entry, hash, id, ...x }) => x);
          return send(res, 200, {
            target: plan.target, label: plan.label, status: plan.status, hash: plan.hash, previewText: plan.previewText,
            counts: { create: plan.create.length, update: plan.update.length, delete: plan.delete.length, unchanged: plan.unchanged, skipped: plan.skipped },
            create: items(plan.create), update: items(plan.update), delete: items(plan.delete),
          });
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          const str = (v) => (v === undefined || v === null ? undefined : String(v));
          return send(res, 200, await store.postSync({ target: str(body.target), from: str(body.from), to: str(body.to), tz: str(body.tz) }, String(body.hash || '')));
        }
      } catch (err) {
        return send(res, err.status || 400, { error: err.message });
      }
    }
    if (req.method === 'GET' && parts[1] === 'costs') {
      const p = Object.fromEntries(url.searchParams);
      return send(res, 200, out({ ...store.costs(p), pricing: { asOf: PRICING_AS_OF, source: PRICING_SOURCE } }));
    }
    if (req.method === 'GET' && parts[1] === 'sessions' && parts.length === 3) {
      const s = store.sessions().find((x) => x.id === parts[2]);
      if (!s) return send(res, 404, { error: 'not found' });
      const [git, tasks] = await Promise.all([store.gitFor(s.id), store.resolvedTasks(s, { enrich: true, onUpdate: () => broadcast('update') })]);
      return send(res, 200, out({ ...s, git, tasks }));
    }
    if (req.method === 'POST' && parts[1] === 'sessions' && parts[3] === 'summarize') {
      if (!llmAvailable(env)) return send(res, 400, { error: 'ANTHROPIC_API_KEY が設定されていないため、LLM要約は使えません' });
      try {
        const s = await store.summarize(parts[2], { force: url.searchParams.get('force') === '1', env });
        broadcast('update');
        return send(res, 200, out(s));
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }
    // hook / rescan: フックからの通知と手動の再スキャン。どちらも差分を取り込んで画面へ知らせる
    if (req.method === 'POST' && (parts[1] === 'rescan' || parts[1] === 'hook')) {
      req.resume();
      const r = await store.scan();
      if (r.changed || r.hookEvents) broadcast('update');
      if (r.hookEvents) store.notifySessionEnds().catch(() => {});
      return send(res, 200, r);
    }
    if (req.method === 'GET' && parts[1] === 'events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    send(res, 404, { error: 'not found' });
  }

  async function handleStatic(res, url) {
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'forbidden' });
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      send(res, 404, { error: 'not found' });
    }
  }

  function broadcast(event) {
    for (const c of clients) c.write(`event: ${event}\ndata: {}\n\n`);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // DNS リバインディング対策: Host が自分(127.0.0.1 / localhost)のときだけ応じる
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return send(res, 403, { error: 'forbidden host' });
    // 他のサイトのページからの書き込み(CSRF)を断る。フックからの通知は Origin を付けないので通る
    if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
      return send(res, 403, { error: 'forbidden origin' });
    }
    const p = url.pathname.startsWith('/api/') ? handleApi(req, res, url) : handleStatic(res, url);
    p.catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    });
  });

  // ログディレクトリを監視し、変化があれば差分スキャンしてブラウザへ通知する
  let timer = null;
  const ac = new AbortController();
  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const r = await store.scan().catch(() => ({ changed: 0 }));
      if (r.changed || r.hookEvents) broadcast('update');
      if (r.hookEvents) store.notifySessionEnds().catch(() => {});
    }, 500);
  };
  const watchDir = async (dir, quiet) => {
    try {
      for await (const _ of watch(dir, { recursive: true, signal: ac.signal })) trigger();
    } catch (err) {
      // Codex を使っていない環境ではフォルダが無いのが普通なので、黙って定期スキャンに任せる
      if (err.name !== 'AbortError' && !(quiet && err.code === 'ENOENT')) {
        console.warn(`[work-log] ${dir} の監視を開始できません(${err.code || err.message})。定期スキャンのみで動作します`);
      }
    }
  };
  watchDir(store.projectsDir, false);
  for (const src of SOURCES) {
    const dir = store.sourceDirs[src.name];
    if (dir && src.watch) for (const w of src.watch(dir)) watchDir(w, true);
  }
  const poll = setInterval(trigger, 60 * 1000); // 監視漏れと「進行中→完了」の切り替え用
  // 進行中表示を更新するため、クライアントにも定期的に再取得させる
  const tick = setInterval(() => broadcast('tick'), 60 * 1000);
  // フックが通知先を見つけられるよう、待ち受けポートを書き出しておく
  const serverFile = path.join(store.cacheDir, SERVER_FILE);
  server.on('listening', async () => {
    await mkdir(store.cacheDir, { recursive: true });
    await writeFile(serverFile, JSON.stringify({ port: server.address().port, pid: process.pid }));
  });
  server.on('close', () => {
    rmSync(serverFile, { force: true }); // 直後に process.exit されても消えるよう同期で
    ac.abort();
    clearInterval(poll);
    clearInterval(tick);
    clearTimeout(timer);
    for (const c of clients) c.end();
  });
  return server;
}
