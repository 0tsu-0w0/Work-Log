import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zonedMidnight, periodRange, buildReport, toSlack, plainFromMrkdwn, sessionEndMessage } from '../src/report.js';
import { Slack } from '../src/slack.js';
import { GitHubIssues } from '../src/github.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

test('タイムゾーンでの日付の区切りと、月曜始まりの週', () => {
  assert.equal(new Date(zonedMidnight('2026-10-04', 'Asia/Tokyo')).toISOString(), '2026-10-03T15:00:00.000Z');
  assert.equal(new Date(zonedMidnight('2026-10-04', 'UTC')).toISOString(), '2026-10-04T00:00:00.000Z');
  // 夏時間の終わる日(ニューヨーク 2026-11-01)は 25 時間ある
  const day = periodRange({ period: 'day', date: '2026-11-01', timeZone: 'America/New_York' });
  assert.equal((day.to - day.from) / 3600000, 25);
  const week = periodRange({ period: 'week', date: '2026-10-04', timeZone: 'Asia/Tokyo' }); // 日曜
  assert.equal(week.start, '2026-09-28');
  assert.equal(new Date(week.from).toISOString(), '2026-09-27T15:00:00.000Z');
  assert.equal((week.to - week.from) / 86400000, 7);
  assert.throws(() => periodRange({ date: '10/4', timeZone: 'UTC' }), /YYYY-MM-DD/);
});

const range = periodRange({ period: 'day', date: '2026-10-04', timeZone: 'UTC' });
const sessions = [
  // 前日から日をまたいだセッション: 期間に入る 30 分だけを数える
  { id: 'a', displayTitle: '夜の作業 <script>', project: 'web', tool: 'claude', start: '2026-10-03T23:00:00Z', segments: [{ start: '2026-10-03T23:00:00Z', end: '2026-10-04T00:30:00Z' }], commitList: [{ hash: 'aaa1111', at: '2026-10-03T23:30:00Z' }, { hash: 'bbb2222', at: '2026-10-04T00:10:00Z' }], quietCommits: [] },
  { id: 'b', displayTitle: 'API を直す', project: 'api', tool: 'codex', start: '2026-10-04T05:00:00Z', segments: [{ start: '2026-10-04T05:00:00Z', end: '2026-10-04T06:00:00Z' }], commitList: [], quietCommits: ['2026-10-04T05:50:00Z'] },
  { id: 'c', displayTitle: '別の日', project: 'web', start: '2026-10-05T01:00:00Z', segments: [{ start: '2026-10-05T01:00:00Z', end: '2026-10-05T02:00:00Z' }], commitList: [], quietCommits: [] },
];
const tasks = [{ id: 'WEB-1', label: 'WEB-1', url: 'https://x.atlassian.net/browse/WEB-1', issue: { title: 'A&B', stateLabel: '進行中' }, sessions: [{ id: 'a' }] }];

test('期間内の時間・コミット・プロジェクト・タスクを集計する', () => {
  const r = buildReport({ sessions, tasks, costs: { buckets: [{ usd: 1.5 }, { usd: 0.25 }] }, range });
  assert.deepEqual(r.sessions.map((s) => [s.id, s.activeMs / 60000, s.commits]), [['a', 30, 1], ['b', 60, 1]]);
  assert.deepEqual(r.projects.map((p) => [p.project, p.activeMs / 60000]), [['api', 60], ['web', 30]]);
  assert.deepEqual(r.tasks.map((t) => [t.id, t.activeMs / 60000]), [['WEB-1', 30]]);
  assert.deepEqual(r.totals, { activeMs: 90 * 60000, sessions: 2, commits: 2, usd: 1.75 });
});

test('Slack の mrkdwn: 記号を逃がし、リンクを付け、コストは指定したときだけ', () => {
  const r = buildReport({ sessions, tasks, costs: { buckets: [{ usd: 1.5 }] }, range });
  const m = toSlack(r);
  assert.match(m.preview, /^\*Work Log 日報 2026\/10\/4\(日\)\*\n作業 1時間30分・2セッション・2コミット$/m);
  assert.match(m.preview, /夜の作業 &lt;script&gt;/);
  assert.match(m.preview, /• <https:\/\/x\.atlassian\.net\/browse\/WEB-1\|WEB-1> A&amp;B\(進行中\)  30分/);
  assert.match(m.preview, /05:00 API を直す — api・1時間・1コミット\(Codex\)/);
  assert.doesNotMatch(m.preview, /\$/);
  assert.match(toSlack(r, { includeCost: true }).preview, /API 換算 \$1\.50/);
  assert.equal(m.blocks.at(-1).type, 'context');
  assert.match(m.text, /^Work Log 日報 .*: 作業 1時間30分/);
  assert.equal(plainFromMrkdwn('*見出し* <https://a|名前> &lt;x&gt; &amp;'), '見出し 名前 (https://a) <x> &');
  // 何も無い日
  assert.match(toSlack(buildReport({ sessions: [], range })).preview, /この期間の作業はありません/);
});

test('セッションが多いときは件数を絞り、1セクション3000文字を超えないよう分ける', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: `s${i}`, displayTitle: 'x'.repeat(120), project: 'p', start: '2026-10-04T01:00:00Z',
    segments: [{ start: '2026-10-04T01:00:00Z', end: '2026-10-04T01:10:00Z' }], commitList: [], quietCommits: [],
  }));
  const m = toSlack(buildReport({ sessions: many, range }), { maxSessions: 40 });
  const texts = m.blocks.filter((b) => b.type === 'section').map((b) => b.text.text);
  assert.ok(texts.every((t) => t.length <= 3000));
  assert.ok(texts.length >= 3);
  assert.match(m.preview, /ほか 20 セッション/);
});

function fakeSlack() {
  const calls = [];
  const fetchImpl = async (url, o) => {
    calls.push({ url, ...o });
    if (url.startsWith('https://hooks.example')) return new Response('ok', { status: 200 });
    const p = new URLSearchParams(o.body);
    if (url.endsWith('/chat.postMessage')) return Response.json(p.get('channel') === 'C-bad' ? { ok: false, error: 'channel_not_found' } : { ok: true, channel: 'C1', ts: '1700.1' });
    if (url.endsWith('/chat.getPermalink')) return Response.json({ ok: true, permalink: `https://acme.slack.com/archives/${p.get('channel')}/p${p.get('message_ts')}` });
    return new Response('', { status: 404 });
  };
  return { calls, fetchImpl };
}

test('送り方: Incoming Webhook と Bot トークン(リンク付き)', async () => {
  const f = fakeSlack();
  const hook = new Slack({ env: { SLACK_WEBHOOK_URL: 'https://hooks.example/services/T/B/X' }, fetchImpl: f.fetchImpl });
  assert.deepEqual(hook.status(), { configured: true, mode: 'webhook', destination: 'Incoming Webhook', includeCost: false, notify: null }); // URL は画面に出さない
  assert.deepEqual(await hook.post({ text: 't', blocks: [{ type: 'section' }] }), { url: null });
  assert.equal(f.calls[0].headers['content-type'], 'application/json');
  assert.equal(f.calls[0].redirect, 'error');
  assert.deepEqual(JSON.parse(f.calls[0].body), { text: 't', blocks: [{ type: 'section' }], unfurl_links: false });

  const bot = new Slack({ env: { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_WEBHOOK_URL: 'https://hooks.example/x', WORKLOG_SLACK_API: 'https://slack.example/api' }, config: { channel: '#dev-log' }, fetchImpl: f.fetchImpl });
  assert.equal(bot.status().mode, 'bot'); // 両方あればリンクが取れる Bot を使う
  const r = await bot.post({ text: 't', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'x' } }] });
  const post = f.calls.find((c) => c.url.endsWith('/chat.postMessage'));
  assert.equal(post.headers.authorization, 'Bearer xoxb-1');
  assert.equal(post.headers['content-type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(post.body);
  assert.equal(form.get('channel'), '#dev-log');
  assert.deepEqual(JSON.parse(form.get('blocks')), [{ type: 'section', text: { type: 'mrkdwn', text: 'x' } }]);
  assert.equal(r.url, 'https://acme.slack.com/archives/C1/p1700.1');

  const bad = new Slack({ env: { SLACK_BOT_TOKEN: 'x', SLACK_CHANNEL: 'C-bad', WORKLOG_SLACK_API: 'https://slack.example/api' }, fetchImpl: f.fetchImpl });
  await assert.rejects(bad.post({ text: 't', blocks: [] }), /channel_not_found/);
  await assert.rejects(new Slack({ env: {} }).post({ text: 't' }), /送り先が設定されていません/);
  assert.equal(new Slack({ env: { SLACK_WEBHOOK_URL: 'http://insecure' } }).status().configured, false);
});

test('セッション終了の通知文', () => {
  const m = sessionEndMessage({ displayTitle: 'A<B', project: 'web', activeMs: 25 * 60000, commits: 2, tool: 'codex', cost: { usd: 1.234 }, tasks: [{ label: 'WEB-1', url: 'https://x/WEB-1' }] }, { includeCost: true });
  assert.equal(m.blocks[0].text.text, 'セッション終了: *A&lt;B*\nweb・25分・2コミット・Codex・API 換算 $1.23\nタスク: <https://x/WEB-1|WEB-1>');
});

async function setupStore(t, slackEnv, config) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-log-slack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proj = path.join(root, 'projects', '-web');
  await mkdir(proj, { recursive: true });
  await mkdir(path.join(root, 'cache'), { recursive: true });
  if (config) await writeFile(path.join(root, 'cache', 'config.json'), JSON.stringify(config));
  const now = Date.now();
  const iso = (m) => new Date(now - m * 60000).toISOString();
  const line = (o) => JSON.stringify({ sessionId: 's1', cwd: '/nonexistent/web', ...o });
  await writeFile(path.join(proj, 's1.jsonl'), [
    line({ type: 'user', timestamp: iso(40), message: { role: 'user', content: 'token=abcd1234secret のログイン修正' } }),
    line({ type: 'assistant', timestamp: iso(10), message: { id: 'a', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [] } }),
  ].join('\n'));
  const f = fakeSlack();
  const store = new Store({
    projectsDir: path.join(root, 'projects'), cacheDir: path.join(root, 'cache'),
    github: new GitHubIssues({ cacheDir: path.join(root, 'cache'), env: {}, tokenProvider: async () => null }),
    slack: new Slack({ env: slackEnv, fetchImpl: f.fetchImpl }),
  });
  await store.scan();
  return { root, store, f, now };
}

test('日報: プレビューと同じ内容だけを送り、秘匿情報は伏せる', async (t) => {
  const { store, f } = await setupStore(t, { SLACK_WEBHOOK_URL: 'https://hooks.example/x' });
  const tz = 'UTC';
  const date = new Date().toISOString().slice(0, 10);
  const r = await store.report({ period: 'day', date, tz });
  assert.match(r.preview, /token=\[REDACTED\]/);
  assert.equal(r.totals.sessions, 1);
  await assert.rejects(store.postReport({ period: 'day', date, tz }, 'wrong'), (e) => e.status === 409);
  await store.postReport({ period: 'day', date, tz }, r.hash);
  assert.doesNotMatch(f.calls.at(-1).body, /abcd1234secret/);

  const server = createServer(store, { env: {} });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const pv = await (await fetch(`${base}/api/slack/report?period=week&date=${date}&tz=${tz}`)).json();
  assert.equal(pv.range.period, 'week');
  assert.equal(pv.slack.destination, 'Incoming Webhook');
  assert.equal(pv.blocks, undefined); // 画面にはプレビューの文字列だけを返す
  assert.doesNotMatch(pv.previewText, /\*|&lt;/); // 読みやすい形も返す
  const sent = await fetch(`${base}/api/slack/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ period: 'week', date, tz, hash: pv.hash }) });
  assert.equal(sent.status, 200);
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(JSON.stringify(cfg.slack).includes('hooks.example'), false); // Webhook の URL は画面に渡さない
});

test('セッション終了の通知は設定したときだけ、1回だけ送る', async (t) => {
  const { root, store, f, now } = await setupStore(t, { SLACK_WEBHOOK_URL: 'https://hooks.example/x' }, { slack: { notify: 'session_end' } });
  assert.equal(await store.notifySessionEnds(), 0); // まだ終了イベントが無い
  const ev = (event, minutesAgo) => JSON.stringify({ ts: new Date(now - minutesAgo * 60000).toISOString(), event, sessionId: 's1' }) + '\n';
  await appendFile(path.join(root, 'cache', 'events.jsonl'), ev('SessionStart', 41) + ev('SessionEnd', 5));
  await store.scan();
  assert.equal(await store.notifySessionEnds(), 1);
  assert.match(JSON.parse(f.calls.at(-1).body).blocks[0].text.text, /^セッション終了: \*token=\[REDACTED\] のログイン修正\*/);
  assert.equal(await store.notifySessionEnds(), 0); // 二度送らない

  const quiet = await setupStore(t, { SLACK_WEBHOOK_URL: 'https://hooks.example/x' }); // notify を設定していない
  await appendFile(path.join(quiet.root, 'cache', 'events.jsonl'), ev('SessionEnd', 5));
  await quiet.store.scan();
  assert.equal(await quiet.store.notifySessionEnds(), 0);
  assert.equal(quiet.f.calls.length, 0);
});
