import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Teams } from '../src/teams.js';
import { periodRange, buildReport, toTeams, sessionEndTeams, plainFromTeams } from '../src/report.js';
import { GitHubIssues } from '../src/github.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

const HOOK = 'https://prod-01.japaneast.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=SECRETSIG';

function fakeTeams({ status = 202, body = '' } = {}) {
  const calls = [];
  const fetchImpl = async (url, o) => {
    calls.push({ url, ...o });
    return new Response(body, { status, headers: status === 429 ? { 'retry-after': '3' } : {} });
  };
  return { calls, fetchImpl };
}

test('Teams の Webhook(Workflows・従来の Incoming Webhook)の URL だけを受け付ける', () => {
  const st = (u, extra = {}) => new Teams({ env: { TEAMS_WEBHOOK_URL: u, ...extra } }).status();
  assert.equal(st(HOOK).configured, true);
  assert.equal(st(HOOK).mode, 'workflows');
  assert.equal(st('https://default123.environment.api.powerplatform.com/powerautomate/x').configured, true);
  assert.equal(st('https://contoso.webhook.office.com/webhookb2/x').mode, 'incoming_webhook');
  assert.equal(st('https://evil.example/webhookb2/x').configured, false);
  assert.equal(st('https://webhook.office.com.evil.example/x').configured, false);
  assert.equal(st('http://contoso.webhook.office.com/x').configured, false);
  assert.equal(st('not a url').configured, false);
  assert.equal(st('http://127.0.0.1:9/x', { WORKLOG_TEAMS_WEBHOOK_ANY: '1' }).configured, true); // テスト用
  assert.deepEqual(new Teams({ env: {} }).status(), { configured: false, mode: null, destination: null, includeCost: false, notify: null });
});

test('送信: Adaptive Card をそのまま POST し、エラーと制限を伝える', async () => {
  const f = fakeTeams();
  const t = new Teams({ env: { TEAMS_WEBHOOK_URL: HOOK }, fetchImpl: f.fetchImpl });
  const msg = sessionEndTeams({ displayTitle: 'x', project: 'web', activeMs: 60000, commits: 0 });
  assert.deepEqual(await t.post(msg), { url: null });
  assert.equal(f.calls[0].url, HOOK);
  assert.equal(f.calls[0].redirect, 'error');
  assert.deepEqual(JSON.parse(f.calls[0].body), msg);
  // 従来の Incoming Webhook は 200 で "1" を返す。それ以外の本文はエラーの説明
  const legacy = (body) => new Teams({ env: { TEAMS_WEBHOOK_URL: 'https://c.webhook.office.com/webhookb2/x' }, fetchImpl: fakeTeams({ status: 200, body }).fetchImpl });
  assert.deepEqual(await legacy('1').post(msg), { url: null });
  await assert.rejects(legacy('Webhook message delivery failed with error: Microsoft Teams endpoint returned HTTP error 413').post(msg), /413/);
  await assert.rejects(new Teams({ env: { TEAMS_WEBHOOK_URL: HOOK }, fetchImpl: fakeTeams({ status: 429 }).fetchImpl }).post(msg), /3秒後/);
  await assert.rejects(new Teams({ env: { TEAMS_WEBHOOK_URL: HOOK }, fetchImpl: fakeTeams({ status: 400, body: 'bad' }).fetchImpl }).post(msg), /Teams Webhook 400: bad/);
  await assert.rejects(new Teams({ env: {} }).post(msg), /TEAMS_WEBHOOK_URL/);
});

const range = periodRange({ period: 'day', date: '2026-10-04', timeZone: 'UTC' });
const one = (i, title = `作業${i}`) => ({
  id: `s${i}`, displayTitle: title, project: 'web', start: '2026-10-04T01:00:00Z',
  segments: [{ start: '2026-10-04T01:00:00Z', end: '2026-10-04T01:20:00Z' }], commitList: [], quietCommits: [],
});
const texts = (m) => m.attachments[0].content.body.map((b) => b.text);

test('Adaptive Card: Markdown の記号を無害にし、タスクはリンクにする', () => {
  const r = buildReport({
    sessions: [one(1, '**太字** _x_ [a](b)')],
    tasks: [{ id: 'WEB-1', label: 'WEB-1', url: 'https://x.example/browse/WEB-1 (a)', issue: { title: 'A_B', stateLabel: 'Done' }, sessions: [{ id: 's1' }] }],
    costs: { buckets: [{ usd: 2 }] },
    range,
  });
  const m = toTeams(r, { includeCost: true });
  assert.equal(m.type, 'message');
  const a = m.attachments[0];
  assert.equal(a.contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(a.content.type, 'AdaptiveCard');
  const t = texts(m);
  assert.equal(t[0], 'Work Log 日報 2026/10/4(日)');
  assert.equal(t[1], '作業 20分・1セッション・0コミット・API換算 $2.00(参考値)');
  assert.ok(t.some((x) => x.includes('＊＊太字＊＊ ＿x＿ ［a］(b)')));
  assert.ok(t.some((x) => x === '- [WEB-1](https://x.example/browse/WEB-1%20%28a%29) A＿B(Done)  20分'));
  assert.ok(!texts(toTeams(r)).some((x) => x.includes('$'))); // コストは指定したときだけ
  assert.equal(plainFromTeams('**見出し**\n- [WEB-1](https://a) A'), '見出し\n- WEB-1 (https://a) A');
  assert.match(m.preview, /^\*\*Work Log 日報/);
});

test('Adaptive Card: 28KB の上限に収める', () => {
  const many = Array.from({ length: 400 }, (_, i) => one(i, 'とても長いセッションのタイトル'.repeat(8)));
  const m = toTeams(buildReport({ sessions: many, range }), { maxSessions: 400 });
  const { preview, ...card } = m;
  assert.ok(Buffer.byteLength(JSON.stringify(card)) <= 28 * 1024);
  assert.ok(texts(m).some((x) => /ほか \d+ セッション$/.test(x)));
});

test('セッション終了の通知(Teams)', () => {
  const m = sessionEndTeams({ displayTitle: 'ログイン修正', project: 'web', activeMs: 25 * 60000, commits: 1, tasks: [{ label: '#12', url: 'https://github.com/a/b/issues/12' }, { label: 'X', url: 'javascript:alert(1)' }] });
  assert.deepEqual(texts(m), ['セッション終了: ログイン修正', 'web・25分・1コミット', 'タスク: [#12](https://github.com/a/b/issues/12), X']);
});

async function setup(t, config) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-log-teams-'));
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
  const f = fakeTeams();
  const store = new Store({
    projectsDir: path.join(root, 'projects'), cacheDir: path.join(root, 'cache'),
    github: new GitHubIssues({ cacheDir: path.join(root, 'cache'), env: {}, tokenProvider: async () => null }),
    teams: new Teams({ env: { TEAMS_WEBHOOK_URL: HOOK }, fetchImpl: f.fetchImpl }),
  });
  await store.scan();
  return { root, store, f, now };
}

test('日報を Teams に送る(プレビューと同じ内容だけ、秘匿情報は伏せる)', async (t) => {
  const { store, f } = await setup(t);
  const date = new Date().toISOString().slice(0, 10);
  const r = await store.report({ target: 'teams', period: 'day', date, tz: 'UTC' });
  assert.equal(r.target, 'teams');
  assert.ok(r.preview.includes('［GITHUB＿TOKEN］'), r.preview);
  assert.doesNotMatch(r.preview, /ghp/);
  const sent = await store.postReport({ target: 'teams', period: 'day', date, tz: 'UTC' }, r.hash);
  assert.equal(sent.url, null);
  assert.doesNotMatch(f.calls.at(-1).body, /ghp_abcdefghij/);
  assert.equal(JSON.parse(f.calls.at(-1).body).preview, undefined); // プレビュー用の文字列は送らない

  const server = createServer(store, { env: {} });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const pv = await (await fetch(`${base}/api/report?target=teams&period=week&date=${date}&tz=UTC`)).json();
  assert.equal(pv.target, 'teams');
  assert.doesNotMatch(pv.previewText, /\*\*/);
  const res = await fetch(`${base}/api/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'teams', period: 'week', date, tz: 'UTC', hash: pv.hash }) });
  assert.equal(res.status, 200);
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.teams.configured, true);
  assert.equal(JSON.stringify(cfg).includes('SECRETSIG'), false); // Webhook の URL は画面に渡さない
});

test('セッション終了の通知(Teams)は1回だけ', async (t) => {
  const { root, store, f, now } = await setup(t, { teams: { notify: 'session_end' } });
  const ev = (event, minutesAgo) => JSON.stringify({ ts: new Date(now - minutesAgo * 60000).toISOString(), event, sessionId: 's1' }) + '\n';
  await appendFile(path.join(root, 'cache', 'events.jsonl'), ev('SessionEnd', 5));
  await store.scan();
  assert.equal(await store.notifySessionEnds(), 1);
  assert.match(texts(JSON.parse(f.calls.at(-1).body))[0], /^セッション終了: ［GITHUB＿TOKEN］ を使う修正/);
  assert.equal(await store.notifySessionEnds(), 0);
});
