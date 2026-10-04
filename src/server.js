// ローカル専用のHTTPサーバー。127.0.0.1 にのみバインドする。
import http from 'node:http';
import { readFile, watch } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mask } from './mask.js';
import { llmAvailable, DEFAULT_MODEL } from './summarizer.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const LIST_FIELDS = [
  'id', 'project', 'cwd', 'gitBranch', 'displayTitle', 'start', 'end', 'segments', 'activeMs', 'status',
  'messageCount', 'commits', 'workType', 'components', 'summarySource',
];

function maskDeep(v) {
  if (typeof v === 'string') return mask(v);
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)]));
  return v;
}

export function filterSessions(sessions, { from, to, project, tag, q } = {}) {
  const fromMs = from ? Date.parse(from) : -Infinity;
  const toMs = to ? Date.parse(to) : Infinity;
  const needle = q?.trim().toLowerCase();
  return sessions.filter((s) => {
    if (Date.parse(s.end) < fromMs || Date.parse(s.start) >= toMs) return false;
    if (project && s.project !== project) return false;
    if (tag && s.workType !== tag && !s.components.includes(tag)) return false;
    if (needle) {
      const hay = [s.displayTitle, s.title, s.summary, s.project, s.gitBranch, ...s.prompts, ...s.changedFiles, ...s.components]
        .filter(Boolean).join('\n').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
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
      return send(res, 200, { llm: llmAvailable(env), model: env.WORKLOG_MODEL || DEFAULT_MODEL, masking: shouldMask, projectsDir: store.projectsDir });
    }
    if (req.method === 'GET' && parts[1] === 'sessions' && parts.length === 2) {
      const all = store.sessions();
      const p = Object.fromEntries(url.searchParams);
      const list = filterSessions(all, p).map((s) => pick(s, LIST_FIELDS));
      const projects = [...new Set(all.map((s) => s.project))].sort();
      const tags = [...new Set(all.flatMap((s) => [s.workType, ...s.components]))].filter(Boolean).sort();
      return send(res, 200, out({ sessions: list, projects, tags }));
    }
    if (req.method === 'GET' && parts[1] === 'sessions' && parts.length === 3) {
      const s = store.sessions().find((x) => x.id === parts[2]);
      return s ? send(res, 200, out(s)) : send(res, 404, { error: 'not found' });
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
    if (req.method === 'POST' && parts[1] === 'rescan') {
      const r = await store.scan();
      if (r.changed) broadcast('update');
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
      if (r.changed) broadcast('update');
    }, 500);
  };
  (async () => {
    try {
      for await (const _ of watch(store.projectsDir, { recursive: true, signal: ac.signal })) trigger();
    } catch (err) {
      if (err.name !== 'AbortError') console.warn(`[work-log] ファイル監視を開始できません(${err.code || err.message})。定期スキャンのみで動作します`);
    }
  })();
  const poll = setInterval(trigger, 60 * 1000); // 監視漏れと「進行中→完了」の切り替え用
  // 進行中表示を更新するため、クライアントにも定期的に再取得させる
  const tick = setInterval(() => broadcast('tick'), 60 * 1000);
  server.on('close', () => {
    ac.abort();
    clearInterval(poll);
    clearInterval(tick);
    clearTimeout(timer);
    for (const c of clients) c.end();
  });
  return server;
}
