import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Discord } from '../src/discord.js';
import { Slack } from '../src/slack.js';
import { periodRange, buildReport, toDiscord, sessionEndDiscord, plainFromDiscord } from '../src/report.js';
import { GitHubIssues } from '../src/github.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

const HOOK = 'https://discord.com/api/webhooks/123456789/abc-DEF_ghi';

function fakeDiscord({ status = 200, body = { id: '9', channel_id: '8', guild_id: '7' } } = {}) {
  const calls = [];
  const fetchImpl = async (url, o) => {
    calls.push({ url, ...o });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

test('Discord の Webhook の URL だけを受け付ける', () => {
  const ok = (u, extra = {}) => new Discord({ env: { DISCORD_WEBHOOK_URL: u, ...extra } }).status().configured;
  assert.equal(ok(HOOK), true);
  assert.equal(ok('https://discordapp.com/api/webhooks/1/x'), true);
  assert.equal(ok('https://discord.com/api/v10/webhooks/1/x'), true);
  assert.equal(ok('https://evil.example/api/webhooks/1/x'), false);
  assert.equal(ok('http://discord.com/api/webhooks/1/x'), false);
  assert.equal(ok('https://local.example/x', { WORKLOG_DISCORD_WEBHOOK_ANY: '1' }), true); // テスト用
  assert.deepEqual(new Discord({ env: { DISCORD_WEBHOOK_URL: HOOK } }).status(), { configured: true, mode: 'webhook', destination: 'Discord Webhook', includeCost: false, notify: null });
});

test('送信: メンションを止め、作成されたメッセージへのリンクを返す', async () => {
  const f = fakeDiscord();
  const d = new Discord({ env: { DISCORD_WEBHOOK_URL: HOOK }, fetchImpl: f.fetchImpl, config: { username: 'ログ係' } });
  const r = await d.post({ content: '', embeds: [{ title: 't' }] });
  assert.equal(f.calls[0].url, `${HOOK}?wait=true`);
  assert.equal(f.calls[0].redirect, 'error');
  assert.deepEqual(JSON.parse(f.calls[0].body), { content: '', embeds: [{ title: 't' }], username: 'ログ係', allowed_mentions: { parse: [] } });
  assert.equal(r.url, 'https://discord.com/channels/7/8/9');
  const limited = new Discord({ env: { DISCORD_WEBHOOK_URL: HOOK }, fetchImpl: fakeDiscord({ status: 429, body: { retry_after: 1.5 } }).fetchImpl });
  await assert.rejects(limited.post({ embeds: [] }), /1\.5秒後/);
  const broken = new Discord({ env: { DISCORD_WEBHOOK_URL: HOOK }, fetchImpl: fakeDiscord({ status: 404, body: { message: 'Unknown Webhook' } }).fetchImpl });
  await assert.rejects(broken.post({ embeds: [] }), /Discord Webhook 404/);
  await assert.rejects(new Discord({ env: {} }).post({ embeds: [] }), /DISCORD_WEBHOOK_URL/);
});

const range = periodRange({ period: 'day', date: '2026-10-04', timeZone: 'UTC' });
const one = (i, title = `作業${i}`) => ({
  id: `s${i}`, displayTitle: title, project: 'web', start: '2026-10-04T01:00:00Z',
  segments: [{ start: '2026-10-04T01:00:00Z', end: '2026-10-04T01:20:00Z' }], commitList: [], quietCommits: [],
});

test('embeds: Markdown の記号を逃がし、タスクはリンクにする', () => {
  const r = buildReport({
    sessions: [one(1, '**太字** _x_ @everyone [a](b)')],
    tasks: [{ id: 'WEB-1', label: 'WEB-1', url: 'https://x.example/browse/WEB-1', issue: { title: 'A_B', stateLabel: 'Done' }, sessions: [{ id: 's1' }] }],
    costs: { buckets: [{ usd: 2 }] },
    range,
  });
  const m = toDiscord(r, { includeCost: true });
  assert.equal(m.embeds[0].title, 'Work Log 日報 2026/10/4(日)');
  assert.equal(m.embeds[0].description, '作業 20分・1セッション・0コミット・API換算 $2.00(参考値)');
  const sessions = m.embeds.find((e) => e.title === 'セッション').description;
  assert.match(sessions, /\\\*\\\*太字\\\*\\\* \\_x\\_ @everyone \\\[a\\\]\\\(b\\\)/);
  assert.match(m.embeds.find((e) => e.title === 'タスク').description, /• \[WEB\\-1\]\(https:\/\/x\.example\/browse\/WEB-1\) A\\_B\(Done\)  20分/);
  assert.ok(m.embeds.at(-1).footer.text.includes('Work Log'));
  assert.doesNotMatch(toDiscord(r).embeds[0].description, /\$/); // コストは指定したときだけ
  assert.equal(plainFromDiscord('**見出し**\n[WEB\\-1](https://a) A\\_B'), '見出し\nWEB-1 (https://a) A_B');
});

test('embeds: 上限(説明 4096 文字・合計 6000 文字・10 個)に収める', () => {
  const many = Array.from({ length: 200 }, (_, i) => one(i, 'とても長いセッションのタイトル'.repeat(4)));
  const m = toDiscord(buildReport({ sessions: many, range }), { maxSessions: 200 });
  const total = m.embeds.reduce((n, e) => n + (e.title || '').length + (e.description || '').length + (e.footer?.text || '').length, 0);
  assert.ok(total <= 6000, `total ${total}`);
  assert.ok(m.embeds.every((e) => e.description.length <= 4096 && e.title.length <= 256));
  assert.ok(m.embeds.length <= 10);
  assert.match(m.embeds.find((e) => e.title === 'セッション').description, /…ほか \d+ 行$/);
});

test('セッション終了の通知(Discord)', () => {
  const m = sessionEndDiscord({ displayTitle: 'ログイン修正', project: 'web', activeMs: 25 * 60000, commits: 1, tasks: [{ label: '#12', url: 'https://github.com/a/b/issues/12' }] });
  assert.deepEqual(m.embeds[0].title, 'セッション終了: ログイン修正');
  assert.equal(m.embeds[0].description, 'web・25分・1コミット\nタスク: [\\#12](https://github.com/a/b/issues/12)');
});

async function setup(t, config) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-log-discord-'));
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
  const d = fakeDiscord();
  const s = { calls: [] };
  const store = new Store({
    projectsDir: path.join(root, 'projects'), cacheDir: path.join(root, 'cache'),
    github: new GitHubIssues({ cacheDir: path.join(root, 'cache'), env: {}, tokenProvider: async () => null }),
    discord: new Discord({ env: { DISCORD_WEBHOOK_URL: HOOK }, fetchImpl: d.fetchImpl }),
    slack: new Slack({ env: { SLACK_WEBHOOK_URL: 'https://hooks.example/x' }, fetchImpl: async (url, o) => (s.calls.push({ url, ...o }), new Response('ok')) }),
  });
  await store.scan();
  return { root, store, d, s, now };
}

test('日報を Discord に送る(プレビューと同じ内容だけ、秘匿情報は伏せる)', async (t) => {
  const { store, d } = await setup(t);
  const date = new Date().toISOString().slice(0, 10);
  const r = await store.report({ target: 'discord', period: 'day', date, tz: 'UTC' });
  assert.equal(r.target, 'discord');
  // 書式を整える前に伏せるので、Discord 用に記号を逃がした形で残る
  assert.ok(r.preview.includes('\\[GITHUB\\_TOKEN\\]'), r.preview);
  assert.doesNotMatch(r.preview, /ghp/);
  const slackHash = (await store.report({ target: 'slack', period: 'day', date, tz: 'UTC' })).hash;
  assert.notEqual(slackHash, r.hash); // 送り先が違えば別の内容
  await assert.rejects(store.postReport({ target: 'discord', period: 'day', date, tz: 'UTC' }, slackHash), (e) => e.status === 409);
  const sent = await store.postReport({ target: 'discord', period: 'day', date, tz: 'UTC' }, r.hash);
  assert.equal(sent.url, 'https://discord.com/channels/7/8/9');
  assert.doesNotMatch(d.calls.at(-1).body, /ghp_abcdefghij/);

  const server = createServer(store, { env: {} });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const pv = await (await fetch(`${base}/api/report?target=discord&period=week&date=${date}&tz=UTC`)).json();
  assert.equal(pv.target, 'discord');
  assert.doesNotMatch(pv.previewText, /\*\*/);
  const res = await fetch(`${base}/api/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'discord', period: 'week', date, tz: 'UTC', hash: pv.hash }) });
  assert.equal(res.status, 200);
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.discord.configured, true);
  assert.equal(JSON.stringify(cfg).includes('abc-DEF_ghi'), false); // Webhook の URL は画面に渡さない
});

test('セッション終了の通知は、設定した送り先それぞれに1回だけ', async (t) => {
  const { root, store, d, s, now } = await setup(t, { slack: { notify: 'session_end' }, discord: { notify: 'session_end' } });
  const ev = (event, minutesAgo) => JSON.stringify({ ts: new Date(now - minutesAgo * 60000).toISOString(), event, sessionId: 's1' }) + '\n';
  await appendFile(path.join(root, 'cache', 'events.jsonl'), ev('SessionEnd', 5));
  await store.scan();
  assert.equal(await store.notifySessionEnds(), 2);
  assert.match(JSON.parse(d.calls.at(-1).body).embeds[0].title, /^セッション終了: \[GITHUB_TOKEN\] を使う修正/);
  assert.equal(s.calls.length, 1);
  assert.equal(await store.notifySessionEnds(), 0);
});
