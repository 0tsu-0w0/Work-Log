import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildMetrics, escapeLabel, escapeHelp, CONTENT_TYPE } from '../src/metrics.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

test('ラベルの値と HELP のエスケープ', () => {
  assert.equal(escapeLabel('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
  assert.equal(escapeHelp('a\\b\nc"d'), 'a\\\\b\\nc"d');
});

test('指標: HELP / TYPE、ラベルごとの合計、伏せたラベル、作業中の数', () => {
  const text = buildMetrics({
    sessions: [
      { project: 'web', tool: 'claude', activeMs: 1500, commits: 2, status: 'done' },
      { project: 'web', tool: 'claude', activeMs: 500, commits: 1, status: 'working' },
      { project: 'a"b\\c', tool: 'codex', activeMs: 60000, commits: 0, status: 'waiting' },
      { project: 'ghp_abcdefghijklmnopqrstuvwxyz0123', tool: 'claude', activeMs: 0, status: 'done' },
    ],
    costs: {
      buckets: [
        { hour: '2026-10-05T01', model: 'claude-opus-5-5', project: 'web', tool: 'claude', tokens: [1, 2, 3, 4, 5, 0], usd: 0.1, priced: true },
        { hour: '2026-10-05T02', model: 'claude-opus-5-5', project: 'web', tool: 'claude', tokens: [10, 20, 30, 40, 50, 0], usd: 0.2, priced: true },
        { hour: '2026-10-05T02', model: 'mystery', project: 'web', tool: 'claude', tokens: [7, 0, 0, 0, 0, 0], usd: 0, priced: false },
      ],
    },
  });
  const lines = text.split('\n');
  assert.ok(text.endsWith('\n'));
  for (const name of ['work_log_active_seconds_total', 'work_log_sessions_total', 'work_log_commits_total', 'work_log_api_equivalent_usd_total', 'work_log_tokens_total']) {
    assert.ok(lines.includes(`# TYPE ${name} counter`), name);
    assert.ok(lines.some((l) => l.startsWith(`# HELP ${name} `)), name);
  }
  assert.ok(lines.includes('# TYPE work_log_in_progress_sessions gauge'));
  assert.ok(lines.includes('work_log_active_seconds_total{project="web",tool="claude"} 2'));
  assert.ok(lines.includes('work_log_active_seconds_total{project="a\\"b\\\\c",tool="codex"} 60'));
  assert.ok(lines.includes('work_log_sessions_total{project="web",tool="claude"} 2'));
  assert.ok(lines.includes('work_log_sessions_total{project="[GITHUB_TOKEN]",tool="claude"} 1'));
  assert.doesNotMatch(text, /ghp_/);
  assert.ok(lines.includes('work_log_commits_total{project="web",tool="claude"} 3'));
  // 0.1 + 0.2 の丸め誤差は出さない。単価のわからないモデルはコストに含めない(トークンは数える)
  assert.ok(lines.includes('work_log_api_equivalent_usd_total{project="web",tool="claude",model="claude-opus-5-5"} 0.3'));
  assert.equal(lines.filter((l) => l.includes('mystery') && l.startsWith('work_log_api_')).length, 0);
  assert.ok(lines.includes('work_log_tokens_total{model="claude-opus-5-5",type="input"} 11'));
  assert.ok(lines.includes('work_log_tokens_total{model="claude-opus-5-5",type="cache_write_1h"} 55'));
  assert.ok(lines.includes('work_log_tokens_total{model="mystery",type="input"} 7'));
  assert.ok(lines.includes('work_log_in_progress_sessions 2'));
  // 形式: コメントか「名前{ラベル} 値」だけ
  for (const l of lines.filter(Boolean)) assert.match(l, /^(# (HELP|TYPE) \w+ .+|[a-z_]+(\{([a-z_]+="([^"\\\n]|\\["\\n])*",?)+\})? -?[\d.e+-]+)$/, l);
});

test('/metrics: 有効にしたときだけ・Host の確かめは他と同じ', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-log-metrics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proj = path.join(root, 'projects', '-web');
  await mkdir(proj, { recursive: true });
  const ts = (m) => new Date(Date.parse('2026-10-05T01:00:00Z') + m * 60000).toISOString();
  const l = (o) => JSON.stringify({ sessionId: 's1', cwd: '/nonexistent/web', ...o });
  await writeFile(path.join(proj, 's1.jsonl'), [
    l({ type: 'user', timestamp: ts(0), message: { role: 'user', content: '作業' } }),
    l({ type: 'assistant', timestamp: ts(10), message: { id: 'm1', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [], usage: { input_tokens: 100, output_tokens: 50 } } }),
  ].join('\n'));
  const store = new Store({ projectsDir: path.join(root, 'projects'), cacheDir: path.join(root, 'cache') });
  await store.scan();
  const start = async (env) => {
    const server = createServer(store, { env });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });
    return server.address().port;
  };
  const get = (port, { host, method = 'GET' } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/metrics', method, headers: host ? { host } : {} }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.on('error', reject);
    req.end();
  });

  const off = await start({});
  assert.equal((await get(off)).status, 404);

  const on = await start({ WORKLOG_METRICS: '1' });
  const r = await get(on);
  assert.equal(r.status, 200);
  assert.equal(r.type, CONTENT_TYPE);
  assert.match(r.body, /^work_log_active_seconds_total\{project="web",tool="claude"\} 600$/m);
  assert.match(r.body, /^work_log_tokens_total\{model="claude-opus-5-5",type="output"\} 50$/m);
  assert.equal((await get(on, { host: 'evil.example' })).status, 403); // DNS リバインディング対策は /metrics にも
  assert.equal((await get(on, { host: `localhost:${on}` })).status, 200);
  assert.equal((await get(on, { method: 'POST' })).status, 405);
  const head = await get(on, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');

  // config.json の metrics.enabled でも有効になる
  await writeFile(path.join(root, 'cache', 'config.json'), JSON.stringify({ metrics: { enabled: true } }));
  await store.scan();
  assert.equal((await get(off)).status, 200);
});
