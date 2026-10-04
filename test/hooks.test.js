import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, appendFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toEventRecord, handleHook } from '../src/hook.js';
import { HookLog, applyEvent, deriveStatus, STALE_MS } from '../src/live.js';
import { addHooks, removeHooks, installedEvents, install, uninstall, isOurCommand, hookCommand } from '../src/install.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const ID = '11111111-2222-3333-4444-555555555555';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', `${ID}.jsonl`);

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'work-log-hooks-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const ev = (event, ts, extra = {}) => ({ ts, event, sessionId: 's1', ...extra });

test('フック入力から記録する項目だけを取り出す', () => {
  const now = new Date('2026-10-04T00:00:00Z');
  const rec = toEventRecord({ session_id: 's1', hook_event_name: 'UserPromptSubmit', cwd: '/a', transcript_path: '/t.jsonl', prompt: '秘密の依頼' }, now);
  assert.deepEqual(rec, { ts: now.toISOString(), event: 'UserPromptSubmit', sessionId: 's1', cwd: '/a', transcriptPath: '/t.jsonl' });
  assert.equal(toEventRecord({ session_id: 's1', hook_event_name: 'PreToolUse' }), null);
  assert.equal(toEventRecord({ hook_event_name: 'Stop' }), null);
  assert.equal(toEventRecord({ session_id: 's1', hook_event_name: 'SessionEnd', reason: 'logout' }).reason, 'logout');
});

test('イベントからセッションの状態を組み立てる', () => {
  const sessions = {};
  applyEvent(sessions, ev('SessionStart', '2026-10-04T00:00:00Z', { source: 'startup' }));
  applyEvent(sessions, ev('UserPromptSubmit', '2026-10-04T00:01:00Z'));
  applyEvent(sessions, ev('SessionStart', '2026-10-04T00:02:00Z', { source: 'compact' }));
  assert.equal(sessions.s1.lastEvent, 'UserPromptSubmit'); // コンパクトでは状態を変えない
  applyEvent(sessions, ev('Stop', '2026-10-04T00:03:00Z'));
  applyEvent(sessions, ev('SessionEnd', '2026-10-04T00:04:00Z', { reason: 'prompt_input_exit' }));
  assert.equal(sessions.s1.turns, 1);
  assert.equal(sessions.s1.startedAt, '2026-10-04T00:00:00Z');
  assert.equal(sessions.s1.endReason, 'prompt_input_exit');
  applyEvent(sessions, ev('SessionStart', '2026-10-04T05:00:00Z', { source: 'resume' }));
  assert.equal(sessions.s1.endedAt, undefined);
  assert.equal(sessions.s1.startedAt, '2026-10-04T00:00:00Z');
});

test('状態の判定(作業中・入力待ち・完了)', () => {
  const t = Date.parse('2026-10-04T00:10:00Z');
  const logEnd = '2026-10-04T00:09:00Z';
  const h = (lastEvent) => ({ lastEvent, lastEventAt: '2026-10-04T00:08:00Z' });
  assert.equal(deriveStatus(h('UserPromptSubmit'), logEnd, t), 'working');
  assert.equal(deriveStatus(h('Stop'), logEnd, t), 'waiting');
  assert.equal(deriveStatus(h('SessionStart'), logEnd, t), 'waiting');
  assert.equal(deriveStatus(h('SessionEnd'), logEnd, t), 'done');
  // 終了イベントが来ないまま時間が経ったら完了扱い
  assert.equal(deriveStatus(h('UserPromptSubmit'), logEnd, t + STALE_MS), 'done');
  // フックが無いときはログの更新時刻で判定
  assert.equal(deriveStatus(null, logEnd, t), 'working');
  assert.equal(deriveStatus(null, logEnd, t + 10 * 60000), 'done');
});

test('イベントファイルを追記分だけ取り込み、書きかけの行は次回に回す', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'events.jsonl');
  await writeFile(file, JSON.stringify(ev('SessionStart', '2026-10-04T00:00:00Z')) + '\n' + '{"ts":"2026-10-04T00:01:00Z","event":"UserPr');
  const log = new HookLog(dir);
  assert.equal(await log.ingest(), 1);
  assert.equal(log.get('s1').lastEvent, 'SessionStart');
  await appendFile(file, 'omptSubmit","sessionId":"s1"}\n');
  assert.equal(await log.ingest(), 1);
  assert.equal(log.get('s1').lastEvent, 'UserPromptSubmit');
  assert.equal(await log.ingest(), 0);

  // 状態は保存され、再起動後は続きから読む
  const again = new HookLog(dir);
  assert.equal(await again.ingest(), 0);
  assert.equal(again.get('s1').turns, 1);
  assert.equal(again.lastEventAt, '2026-10-04T00:01:00Z');
});

test('大きくなったイベントファイルは取り込み後に作り直す', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'events.jsonl');
  const line = JSON.stringify(ev('Stop', '2026-10-04T00:00:00Z', { cwd: 'x'.repeat(2000) })) + '\n';
  await writeFile(file, line.repeat(2700)); // 約5.4MB
  const log = new HookLog(dir);
  assert.equal(await log.ingest(), 2700);
  assert.equal(log.offset, 0);
  await assert.rejects(stat(file), { code: 'ENOENT' });
  await appendFile(file, JSON.stringify(ev('SessionEnd', '2026-10-04T00:05:00Z')) + '\n');
  assert.equal(await log.ingest(), 1);
  assert.equal(log.get('s1').lastEvent, 'SessionEnd');
});

test('settings.json への登録は既存の設定を壊さず、何度実行しても重複しない', () => {
  const other = { type: 'command', command: 'echo hi' };
  const settings = { model: 'opus', hooks: { Stop: [{ hooks: [other] }], PreToolUse: [{ matcher: 'Bash', hooks: [other] }] } };
  const once = addHooks(settings, 'node "/x/cli.js" hook --work-log');
  const twice = addHooks(once, 'node "/moved/cli.js" hook --work-log');
  assert.deepEqual(installedEvents(twice), ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']);
  assert.equal(twice.hooks.Stop.length, 2);
  assert.deepEqual(twice.hooks.Stop[0].hooks, [other]);
  assert.equal(twice.hooks.Stop[1].hooks[0].command, 'node "/moved/cli.js" hook --work-log');
  assert.equal(twice.hooks.UserPromptSubmit[0].hooks[0].async, true);
  assert.equal(twice.hooks.Stop[1].hooks[0].async, undefined);
  assert.equal(twice.hooks.SessionEnd[0].hooks[0].async, undefined);
  assert.equal(twice.hooks.SessionEnd[0].hooks[0].timeout, 5);
  assert.equal(twice.model, 'opus');

  const removed = removeHooks(twice);
  assert.deepEqual(removed, settings);
  assert.deepEqual(removeHooks(addHooks({})), {});
  assert.ok(isOurCommand(hookCommand()));
  assert.ok(!isOurCommand('node hook'));
});

test('install / uninstall はファイルを書き換え、壊れた設定には触れない', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'settings.json');
  await writeFile(file, JSON.stringify({ theme: 'dark' }));
  await install({ file });
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.theme, 'dark');
  assert.equal(installedEvents(saved).length, 4);
  assert.deepEqual(JSON.parse(await readFile(`${file}.work-log.bak`, 'utf8')), { theme: 'dark' });
  assert.deepEqual((await uninstall({ file })).removed.length, 4);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { theme: 'dark' });

  await writeFile(file, '{ broken');
  await assert.rejects(install({ file }), /JSONとして読めない/);
  assert.equal(await readFile(file, 'utf8'), '{ broken');
});

test('CLI: hooks install --dry-run はファイルを作らない', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'settings.json');
  const { stdout } = await run('node', [CLI, 'hooks', 'install', '--settings', file, '--dry-run']);
  assert.match(stdout, /\[dry-run\]/);
  await assert.rejects(stat(file), { code: 'ENOENT' });
  await run('node', [CLI, 'hooks', 'install', '--settings', file]);
  assert.match((await run('node', [CLI, 'hooks', 'status', '--settings', file])).stdout, /登録済み/);
});

test('CLI: hook は不正な入力でも何も出力せず exit 0', async (t) => {
  const dir = await tmp(t);
  const child = execFile('node', [CLI, 'hook', '--work-log'], { env: { ...process.env, WORKLOG_CACHE_DIR: dir } });
  child.stdin.end('not json');
  const [code, out] = await new Promise((r) => {
    let o = '';
    child.stdout.on('data', (d) => (o += d));
    child.on('close', (c) => r([c, o]));
  });
  assert.equal(code, 0);
  assert.equal(out, '');
});

test('フック → サーバー: 通知を受けると即座に状態が反映される', async (t) => {
  const dir = await tmp(t);
  const projectsDir = path.join(dir, 'projects');
  const cacheDir = path.join(dir, 'cache');
  await mkdir(path.join(projectsDir, '-home-dev-myapp'), { recursive: true });
  await copyFile(FIXTURE, path.join(projectsDir, '-home-dev-myapp', `${ID}.jsonl`));
  const store = new Store({ projectsDir, cacheDir });
  await store.scan();
  const server = createServer(store, { env: {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  // listening ハンドラが server.json を書き終えるのを待つ
  for (let i = 0; i < 50; i++) {
    try {
      await stat(path.join(cacheDir, 'server.json'));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  const base = `http://127.0.0.1:${server.address().port}`;
  const now = new Date();
  await handleHook(JSON.stringify({ session_id: ID, hook_event_name: 'UserPromptSubmit', cwd: '/home/dev/myapp' }), { cacheDir, now });
  let s = await (await fetch(`${base}/api/sessions/${ID}`)).json();
  assert.equal(s.status, 'working');
  assert.equal(s.hook.lastEvent, 'UserPromptSubmit');

  await handleHook(JSON.stringify({ session_id: ID, hook_event_name: 'Stop' }), { cacheDir, now });
  s = await (await fetch(`${base}/api/sessions/${ID}`)).json();
  assert.equal(s.status, 'waiting');

  await handleHook(JSON.stringify({ session_id: ID, hook_event_name: 'SessionEnd', reason: 'logout' }), { cacheDir, now });
  s = await (await fetch(`${base}/api/sessions/${ID}`)).json();
  assert.equal(s.status, 'done');
  assert.equal(s.hook.endReason, 'logout');

  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.hooks.lastEventAt, now.toISOString());
});
