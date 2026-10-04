import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeText, foldLine, icsDate, buildCalendar } from '../src/ical.js';
import { buildEntries, resolveRange } from '../src/sync/entries.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

// 折り返しを戻す(RFC 5545 3.1: CRLF の直後の空白1つを取り除く)
const unfold = (text) => text.replace(/\r\n[ \t]/g, '');

test('TEXT のエスケープ: \\ ; , 改行', () => {
  assert.equal(escapeText('a\\b;c,d\ne\r\nf'), 'a\\\\b\\;c\\,d\\ne\\nf');
  assert.equal(escapeText(null), '');
});

test('75 オクテットで折り返し、UTF-8 の文字の途中では切らない', () => {
  assert.equal(foldLine('SUMMARY:short'), 'SUMMARY:short');
  const long = `SUMMARY:${'あいうえおかきくけこ'.repeat(10)}abc`;
  const folded = foldLine(long);
  const lines = folded.split('\r\n');
  assert.ok(lines.length > 1);
  for (const [i, l] of lines.entries()) {
    assert.ok(Buffer.byteLength(l) <= 75, `${i}: ${Buffer.byteLength(l)}`);
    if (i > 0) assert.ok(l.startsWith(' '));
    assert.doesNotMatch(Buffer.from(l).toString('utf8'), /�/);
  }
  assert.equal(unfold(folded), long);
  const ascii = 'X'.repeat(200);
  assert.deepEqual(foldLine(ascii).split('\r\n').map((l) => l.length), [75, 75, 52]);
});

test('日時は UTC の基本形式', () => {
  assert.equal(icsDate('2026-10-04T01:02:03.456Z'), '20261004T010203Z');
  assert.equal(icsDate(Date.UTC(2026, 0, 2, 3, 4, 5)), '20260102T030405Z');
});

const sess = (o = {}) => ({
  id: 'abc', displayTitle: 'ログイン修正, API; 確認\\ ghp_abcdefghijklmnopqrstuvwxyz0123', project: 'web,app', tool: 'claude', status: 'done', gitBranch: 'main',
  segments: [{ start: '2026-10-01T00:00:00.000Z', end: '2026-10-01T00:40:00.000Z' }, { start: '2026-10-01T03:00:00.000Z', end: '2026-10-01T03:00:00.000Z' }],
  commitList: [{ hash: '1234567abcdef', subject: 'fix: ログイン', at: '2026-10-01T00:30:00.000Z' }, { hash: '89abcdef', subject: 'later', at: '2026-10-01T05:00:00.000Z' }],
  tasks: [{ id: 'WEB-1' }],
  ...o,
});

test('区間ごとに1件の VEVENT(UID は区間ごとに固定、文字列は伏せてからエスケープ)', () => {
  const now = Date.UTC(2026, 9, 4, 12);
  const ics = buildCalendar([sess(), sess({ id: 'other', segments: [{ start: '2026-09-01T00:00:00Z', end: '2026-09-01T01:00:00Z' }] })], { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 2), now });
  assert.ok(ics.endsWith('\r\n'));
  assert.doesNotMatch(ics.replace(/\r\n/g, ''), /[\r\n]/); // 行末はすべて CRLF
  for (const l of ics.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75, l);
  const text = unfold(ics);
  assert.match(text, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\nPRODID:-\/\/Work Log\/\/Work Log\/\/JA\r\n/);
  assert.equal((text.match(/BEGIN:VEVENT/g) || []).length, 2); // 範囲外のセッションは含めない
  assert.ok(text.includes('UID:abc-0@work-log\r\n'));
  assert.ok(text.includes('UID:abc-1@work-log\r\n'));
  assert.ok(text.includes('DTSTAMP:20261004T120000Z'));
  assert.ok(text.includes('DTSTART:20261001T000000Z\r\nDTEND:20261001T004000Z'));
  assert.ok(text.includes('DTSTART:20261001T030000Z\r\nDTEND:20261001T030100Z')); // 長さ0の区間は1分にする
  assert.ok(text.includes('SUMMARY:ログイン修正\\, API\\; 確認\\\\ [GITHUB_TOKEN]\r\n'), text);
  assert.doesNotMatch(text, /ghp_/);
  assert.ok(text.includes('CATEGORIES:web\\,app\r\n'));
  const desc = text.match(/DESCRIPTION:(.*)\r\n/)[1];
  assert.ok(desc.startsWith('プロジェクト: web\\,app\\nツール: Claude Code\\nブランチ: main\\nコミット: 1件\\n- 1234567 fix: ログイン\\nタスク: WEB-1'), desc);
  assert.ok(text.trimEnd().endsWith('END:VCALENDAR'));
});

test('予定の組み立て: まとめる・短いものを除く・終わったものだけ', () => {
  const s = sess();
  assert.deepEqual(buildEntries([s]).map((e) => [e.key, e.ms]), [['abc-0', 2400000], ['abc-1', 0]]);
  assert.deepEqual(buildEntries([s], { minMs: 60000 }).map((e) => e.key), ['abc-0']);
  const merged = buildEntries([s], { mergeSegments: true });
  assert.deepEqual(merged.map((e) => [e.key, e.start, e.end, e.ms]), [['abc', '2026-10-01T00:00:00.000Z', '2026-10-01T03:00:00.000Z', 2400000]]);
  assert.match(merged[0].description, /コミット: 2件/);
  assert.equal(buildEntries([sess({ status: 'working' })], { onlyDone: true }).length, 0);
});

test('期間の解釈: 日付は tz の0時、to はその日を含む。長すぎる期間は断る', () => {
  assert.deepEqual(resolveRange({ from: '2026-10-01', to: '2026-10-01' }, { timeZone: 'Asia/Tokyo' }), { from: Date.parse('2026-09-30T15:00:00Z'), to: Date.parse('2026-10-01T15:00:00Z') });
  const now = Date.parse('2026-10-04T00:00:00Z');
  assert.deepEqual(resolveRange({}, { now, defaultDays: 30 }), { from: now - 30 * 86400000, to: now });
  assert.throws(() => resolveRange({ from: '2025-01-01', to: '2026-10-01' }, { maxDays: 366 }), /長すぎ/);
  assert.throws(() => resolveRange({ from: 'yesterday' }), /読めません/);
  assert.throws(() => resolveRange({ from: '2026-10-02', to: '2026-10-01' }), /後になっています/);
});

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-log-ical-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proj = path.join(root, 'projects', '-web');
  await mkdir(proj, { recursive: true });
  const now = Date.now();
  const iso = (m) => new Date(now - m * 60000).toISOString();
  const line = (o) => JSON.stringify({ sessionId: 's1', cwd: '/nonexistent/web', ...o });
  await writeFile(path.join(proj, 's1.jsonl'), [
    line({ type: 'user', timestamp: iso(120), message: { role: 'user', content: 'ghp_abcdefghijklmnopqrstuvwxyz0123 を使う修正' } }),
    line({ type: 'assistant', timestamp: iso(100), message: { id: 'a', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [] } }),
  ].join('\n'));
  const env = { WORKLOG_PROJECTS_DIR: path.join(root, 'projects'), WORKLOG_CACHE_DIR: path.join(root, 'cache') };
  const store = new Store({ projectsDir: env.WORKLOG_PROJECTS_DIR, cacheDir: env.WORKLOG_CACHE_DIR });
  await store.scan();
  return { root, store, env };
}

test('GET /api/calendar.ics と work-log ical', async (t) => {
  const { store, env } = await setup(t);
  const server = createServer(store, { env: {} });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/calendar.ics`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="work-log-\d{8}-\d{8}\.ics"$/);
  const ics = await res.text();
  assert.ok(ics.includes('UID:s1-0@work-log\r\n'));
  assert.ok(unfold(ics).includes('SUMMARY:[GITHUB_TOKEN] を使う修正'), ics);
  assert.doesNotMatch(ics, /ghp_/);
  // 範囲外は空、長すぎる範囲は断る
  const empty = await (await fetch(`${base}/api/calendar.ics?from=2020-01-01&to=2020-01-31`)).text();
  assert.doesNotMatch(empty, /VEVENT/);
  const bad = await fetch(`${base}/api/calendar.ics?from=2020-01-01&to=2026-01-01`);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /長すぎ/);

  const run = promisify(execFile);
  const out = path.join(env.WORKLOG_CACHE_DIR, 'out.ics');
  const r = await run(process.execPath, [CLI, 'ical', '--out', out], { env: { ...process.env, ...env, HOME: env.WORKLOG_CACHE_DIR } });
  assert.match(r.stderr, /1件/);
  const { readFile } = await import('node:fs/promises');
  assert.ok((await readFile(out, 'utf8')).includes('UID:s1-0@work-log'));
});
