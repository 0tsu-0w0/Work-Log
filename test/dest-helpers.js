// 送り先のテストで共通の部品(テストファイルではない)。ストアを作って日報・週報とセッション終了の通知を確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { periodRange } from '../src/report.js';
import { GitHubIssues } from '../src/github.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

export const range = periodRange({ period: 'day', date: '2026-10-04', timeZone: 'UTC' });

// 20分のセッション1つ分(buildReport に渡す形)
export const one = (i, title = `作業${i}`) => ({
  id: `s${i}`, displayTitle: title, project: 'web', start: '2026-10-04T01:00:00Z',
  segments: [{ start: '2026-10-04T01:00:00Z', end: '2026-10-04T01:20:00Z' }], commitList: [], quietCommits: [],
});

async function setup(t, name, client, config) {
  const root = await mkdtemp(path.join(os.tmpdir(), `work-log-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proj = path.join(root, 'projects', '-web');
  await mkdir(proj, { recursive: true });
  await mkdir(path.join(root, 'cache'), { recursive: true });
  if (config) await writeFile(path.join(root, 'cache', 'config.json'), JSON.stringify(config));
  const now = Date.now();
  const iso = (m) => new Date(now - m * 60000).toISOString();
  const line = (o) => JSON.stringify({ sessionId: 's1', cwd: '/nonexistent/web', ...o });
  await writeFile(path.join(proj, 's1.jsonl'), [
    line({ type: 'user', timestamp: iso(40), message: { role: 'user', content: 'ghp_abcdefghijklmnopqrstuvwxyz0123 を使う修正' } }),
    line({ type: 'assistant', timestamp: iso(10), message: { id: 'a', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [] } }),
  ].join('\n'));
  const store = new Store({
    projectsDir: path.join(root, 'projects'), cacheDir: path.join(root, 'cache'),
    github: new GitHubIssues({ cacheDir: path.join(root, 'cache'), env: {}, tokenProvider: async () => null }),
    destinations: { [name]: client },
  });
  await store.scan();
  return { root, store, now };
}

// 共通の2本: 日報の送信(マスキング・ハッシュの確認・プレビュー・設定に秘密が出ない)とセッション終了の通知(1回だけ)。
// make(): { client, sent() } を返す。sent() は送信した内容(JSON 文字列など)の一覧。secret は /api/config に出てはいけない文字列
export function storeTests(name, { make, secret, sentText, endPattern }) {
  test(`日報を ${name} に送る(プレビューと同じ内容だけ、秘匿情報は伏せる)`, async (t) => {
    const f = make();
    const { store } = await setup(t, name, f.client);
    const date = new Date().toISOString().slice(0, 10);
    const r = await store.report({ target: name, period: 'day', date, tz: 'UTC' });
    assert.equal(r.target, name);
    assert.ok(r.preview.includes('GITHUB'), r.preview);
    assert.doesNotMatch(r.preview, /ghp/);
    assert.equal(f.sent().length, 0); // プレビューでは送らない
    await assert.rejects(store.postReport({ target: name, period: 'day', date, tz: 'UTC' }, 'x'), /プレビューの後に内容が変わりました/);
    await store.postReport({ target: name, period: 'day', date, tz: 'UTC' }, r.hash);
    assert.ok(f.sent().length >= 1);
    assert.doesNotMatch(f.sent().join('\n'), /ghp_abcdefghij/);
    assert.ok(sentText(f.sent()).includes('GITHUB'));

    const server = createServer(store, { env: {} });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((res) => server.close(res));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const pv = await (await fetch(`${base}/api/report?target=${name}&period=week&date=${date}&tz=UTC`)).json();
    assert.equal(pv.target, name);
    assert.equal(typeof pv.previewText, 'string');
    assert.doesNotMatch(pv.previewText, /ghp/);
    const res = await fetch(`${base}/api/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: name, period: 'week', date, tz: 'UTC', hash: pv.hash }) });
    assert.equal(res.status, 200);
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg[name].configured, true);
    assert.ok(cfg.destinations.some((d) => d.name === name));
    assert.equal(JSON.stringify(cfg).includes(secret), false); // トークン・URL・鍵は画面に渡さない
  });

  test(`セッション終了の通知(${name})は1回だけ`, async (t) => {
    const f = make();
    const { root, store, now } = await setup(t, name, f.client, { [name]: { notify: 'session_end' } });
    const ev = (event, minutesAgo) => JSON.stringify({ ts: new Date(now - minutesAgo * 60000).toISOString(), event, sessionId: 's1' }) + '\n';
    await appendFile(path.join(root, 'cache', 'events.jsonl'), ev('SessionEnd', 5));
    await store.scan();
    assert.equal(await store.notifySessionEnds(), 1);
    assert.match(sentText(f.sent()), endPattern);
    assert.equal(await store.notifySessionEnds(), 0);
  });
}
