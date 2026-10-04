// Claude Code の settings.json に Work Log のフックを追加・削除する。
// 既存の設定やほかのフックには触れず、書き換え前にバックアップを残す。
import { readFile, writeFile, copyFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { HOOK_EVENTS } from './hook.js';

const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
const HOOK_TIMEOUT_SEC = 5;

export function settingsPath(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'settings.json');
}

export function hookCommand(cliPath = CLI_PATH) {
  return `node "${cliPath}" hook --work-log`;
}

// 末尾の目印で判定する。リポジトリを移動・改名しても自分のフックを見分けられる
export function isOurCommand(cmd) {
  return typeof cmd === 'string' && /\shook --work-log\s*$/.test(cmd);
}

// 依頼の送信を待たせないよう、開始系はバックグラウンド実行にする。
// Stop と SessionEnd は直後にプロセスが終わることがあり(claude -p など)、
// バックグラウンドだと記録前に打ち切られるため同期で実行する(応答の表示後に約0.2秒)
const SYNC_EVENTS = new Set(['Stop', 'SessionEnd']);

export function hookEntry(event, command = hookCommand()) {
  return SYNC_EVENTS.has(event)
    ? { type: 'command', command, timeout: HOOK_TIMEOUT_SEC }
    : { type: 'command', command, async: true };
}

function stripOurs(groups) {
  return (groups || [])
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurCommand(h.command)) }))
    .filter((g) => g.hooks.length > 0);
}

export function addHooks(settings, command = hookCommand()) {
  const next = { ...settings, hooks: { ...(settings.hooks || {}) } };
  for (const ev of HOOK_EVENTS) {
    next.hooks[ev] = [...stripOurs(next.hooks[ev]), { hooks: [hookEntry(ev, command)] }];
  }
  return next;
}

export function removeHooks(settings) {
  if (!settings.hooks) return settings;
  const hooks = {};
  for (const [ev, groups] of Object.entries(settings.hooks)) {
    const kept = stripOurs(groups);
    if (kept.length) hooks[ev] = kept;
  }
  const next = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  return next;
}

export function installedEvents(settings) {
  return HOOK_EVENTS.filter((ev) => (settings.hooks?.[ev] || []).some((g) => (g.hooks || []).some((h) => isOurCommand(h.command))));
}

export async function readSettings(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    // 壊れた設定を上書きして消さないよう、ここで止める
    throw new Error(`${file} がJSONとして読めないため、変更を中止しました: ${err.message}`);
  }
}

async function writeSettings(file, settings) {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await copyFile(file, `${file}.work-log.bak`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2) + '\n');
  await rename(tmp, file);
}

export async function install({ file = settingsPath(), command = hookCommand(), dryRun = false } = {}) {
  const before = await readSettings(file);
  const after = addHooks(before, command);
  if (!dryRun) await writeSettings(file, after);
  return { file, settings: after, events: installedEvents(after) };
}

export async function uninstall({ file = settingsPath(), dryRun = false } = {}) {
  const before = await readSettings(file);
  const removed = installedEvents(before);
  const after = removeHooks(before);
  if (!dryRun && removed.length) await writeSettings(file, after);
  return { file, settings: after, removed };
}

export async function status({ file = settingsPath() } = {}) {
  try {
    return { file, events: installedEvents(await readSettings(file)) };
  } catch (err) {
    return { file, events: [], error: err.message };
  }
}
