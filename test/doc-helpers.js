// ドキュメント系の送り先(Confluence / esa / Qiita Team / Obsidian)のテストで共通の部品
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitHubIssues } from '../src/github.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { periodRange } from '../src/report.js';

export const range = periodRange({ period: 'day', date: '2026-10-04', timeZone: 'UTC' });
export const weekRange = periodRange({ period: 'week', date: '2026-10-04', timeZone: 'UTC' });

export const one = (i, title = `作業${i}`, extra = {}) => ({
  id: `s${i}`, displayTitle: title, project: 'web', start: '2026-10-04T01:00:00Z',
  segments: [{ start: '2026-10-04T01:00:00Z', end: '2026-10-04T01:20:00Z' }], commitList: [], quietCommits: [], ...extra,
});

// 順番に返す応答を決めて、呼ばれた内容を calls に残す fetch。responses の要素: { status, body, headers } か (url, init) => 応答。最後の要素は使い回す
export function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, o) => {
    calls.push({ url, ...o });
    const r = queue.length > 1 ? queue.shift() : queue[0];
    const { status = 200, body = {}, headers = {} } = typeof r === 'function' ? r(url, o) : r;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { calls, fetchImpl };
}

// 秘匿情報(ghp_…)を含むセッションが1つある Store を作る。destinations は (cacheDir) => ({ 名前: クライアント })
export async function setup(t, { destinations, config, prefix = 'doc' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), `work-log-${prefix}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proj = path.join(root, 'projects', '-web');
  await mkdir(proj, { recursive: true });
  await mkdir(path.join(root, 'cache'), { recursive: true });
  if (config) await writeFile(path.join(root, 'cache', 'config.json'), JSON.stringify(config));
  const now = Date.now();
  const iso = (m) => new Date(now - m * 60000).toISOString();
  const line = (o) => JSON.stringify({ sessionId: 's1', cwd: '/nonexistent/web', ...o });
  await writeFile(
    path.join(proj, 's1.jsonl'),
    [
      line({ type: 'user', timestamp: iso(40), message: { role: 'user', content: 'ghp_abcdefghijklmnopqrstuvwxyz0123 を使う修正' } }),
      line({ type: 'assistant', timestamp: iso(10), message: { id: 'a', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [] } }),
    ].join('\n'),
  );
  const cache = path.join(root, 'cache');
  const store = new Store({
    projectsDir: path.join(root, 'projects'), cacheDir: cache,
    github: new GitHubIssues({ cacheDir: cache, env: {}, tokenProvider: async () => null }),
    destinations: destinations(cache),
  });
  await store.scan();
  return { root, cache, store, now };
}

export async function listen(t, store) {
  const server = createServer(store, { env: {} });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
