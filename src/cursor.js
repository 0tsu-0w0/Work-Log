// Cursor(エディタ)の Composer / Agent のチャットを、Claude Code と同じ形の集計レコードに変換する。
// 注意: Cursor の保存形式は公開されておらず、ここで読んでいる形は非公式なもの。Cursor の更新で変わることがある。
// オープンソースの読み取りツール cursor-history(npm, 0.18)・cursor-chat-history-mcp(npm, 0.2)の実装に合わせている:
//   <ユーザーデータ>/User/globalStorage/state.vscdb(SQLite)の表 cursorDiskKV
//     key "composerData:<composerId>" … {composerId, name, createdAt, lastUpdatedAt, modelConfig: {modelName},
//       fullConversationHeadersOnly: [{bubbleId, type}](新しい形式) / conversation: [バブル…](古い形式、本文を内包)}
//     key "bubbleId:<composerId>:<bubbleId>" … 1発言(バブル) {type: 1=依頼 2=AI, text, createdAt, timingInfo,
//       tokenCount: {inputTokens, outputTokens}, modelInfo: {modelName}, toolFormerData: {name, params, rawArgs, result, status}}
//   <ユーザーデータ>/User/workspaceStorage/<ハッシュ>/state.vscdb の表 ItemTable
//     key "composer.composerData" … {allComposers: [{composerId, …}]}(そのワークスペースのチャット)
//     同じフォルダの workspace.json … {folder: "file:///…"} でプロジェクトのパスが分かる
// SQLite は node:sqlite(Node.js 22.5 以降)で読み取り専用に開く。使えない環境では何も読まない
import { copyFile, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addTime, addUsage, countTool, createCollector, finish, onShell, onShellResult } from './record.js';

const SHELL_TOOLS = new Set(['run_terminal_cmd', 'run_terminal_command', 'run_terminal_command_v2', 'execute_command']);
const EDIT_TOOLS = new Set(['edit_file', 'edit_file_v2', 'search_replace', 'write', 'write_file', 'create_file', 'delete_file', 'MultiEdit', 'multi_edit']);
const MIN_VALID_MS = 1e12; // 秒とミリ秒を見分ける

// Cursor のユーザーデータ(…/Cursor/User)の既定の場所
export function defaultCursorDir(env = process.env, home = os.homedir(), platform = process.platform) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor', 'User');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Cursor', 'User');
}

// node:sqlite は読み込み時に ExperimentalWarning を出す。その警告だけを黙らせる
let sqliteModule;
export async function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  const orig = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const msg = typeof warning === 'string' ? warning : warning?.message;
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type || warning?.name;
    if (type === 'ExperimentalWarning' && /sqlite/i.test(msg || '')) return;
    return orig.call(this, warning, ...rest);
  };
  try {
    sqliteModule = await import('node:sqlite');
  } catch {
    sqliteModule = null;
  } finally {
    process.emitWarning = orig;
  }
  return sqliteModule;
}

// 読み取り専用で開いて fn(db) を実行する。Cursor が書き込み中でロックされていたら、コピーを読む
export async function withDb(file, fn) {
  const sqlite = await loadSqlite();
  if (!sqlite) throw new Error('SQLite を読むには Node.js 22.5 以降が必要です');
  const run = (p) => {
    const db = new sqlite.DatabaseSync(p, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  try {
    return run(file);
  } catch (err) {
    // ロック中・(-shm を作れず)開けないときだけ、コピーを読む
    if (!/locked|busy|unable to open|readonly/i.test(err.message)) throw err;
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'work-log-cursor-'));
    try {
      const copy = path.join(tmp, 'state.vscdb');
      await copyFile(file, copy);
      await copyFile(file + '-wal', copy + '-wal').catch(() => {});
      return run(copy);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

const text = (v) => (v === null || v === undefined ? null : typeof v === 'string' ? v : Buffer.from(v).toString('utf8'));

function parseJson(v) {
  try {
    return JSON.parse(text(v));
  } catch {
    return null;
  }
}

// file:///home/me/app や vscode-remote://… をパスにする
export function uriToPath(uri) {
  if (typeof uri !== 'string') return null;
  if (uri.startsWith('file://')) {
    try {
      return fileURLToPath(uri);
    } catch {
      return decodeURIComponent(uri.replace(/^file:\/\//, ''));
    }
  }
  const m = uri.match(/^[a-z-]+:\/\/[^/]*(\/.*)$/i); // リモート(SSH / WSL / コンテナ)はパスの部分だけ
  return m ? decodeURIComponent(m[1]) : null;
}

// バブルの時刻(cursor-history の extractTimestamp と同じ優先順)
export function bubbleTime(b) {
  if (b.createdAt) {
    const t = typeof b.createdAt === 'number' ? b.createdAt : Date.parse(b.createdAt);
    if (Number.isFinite(t)) return t;
  }
  const ti = b.timingInfo || {};
  for (const k of ['clientRpcSendTime', 'clientSettleTime', 'clientEndTime', 'clientStartTime']) {
    if (typeof ti[k] === 'number' && ti[k] > MIN_VALID_MS) return ti[k];
  }
  return null;
}

function toolParams(t) {
  for (const raw of [t.params, t.rawArgs]) {
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const j = JSON.parse(raw);
        if (j && typeof j === 'object') return j;
      } catch {
        // 次の候補
      }
    }
  }
  return {};
}

const pick = (o, keys) => keys.map((k) => o[k]).find((v) => typeof v === 'string' && v.trim());

// composerData と、順に並べたバブルからセッションを作る
export function parseCursorComposer(composer, bubbles, { file = '', cwd = null } = {}) {
  const c = createCollector();
  const defaultModel = composer?.modelConfig?.modelName || null;
  for (const b of bubbles) {
    if (!b || typeof b !== 'object') continue;
    const t = bubbleTime(b);
    const at = t ? addTime(c, t) : null;
    const body = typeof b.text === 'string' ? b.text.trim() : '';
    if (b.type === 1) {
      if (body) c.prompts.push(body);
      continue;
    }
    if (b.type !== 2) continue;
    const tool = b.toolFormerData && typeof b.toolFormerData.name === 'string' ? b.toolFormerData : null;
    if (body || tool) c.assistantMessages++;
    if (body) c.assistantTexts.push(body);
    const model = typeof b.modelInfo?.modelName === 'string' && b.modelInfo.modelName ? b.modelInfo.modelName : defaultModel;
    if (model && (body || tool)) c.models.add(model);
    const tk = b.tokenCount;
    if (tk && (tk.inputTokens > 0 || tk.outputTokens > 0)) addUsage(c, at ?? NaN, model, { input: tk.inputTokens, output: tk.outputTokens });
    if (!tool) continue;
    countTool(c, tool.name);
    const params = toolParams(tool);
    const status = tool.additionalData?.status || tool.status;
    const failed = status === 'error' || status === 'cancelled';
    if (EDIT_TOOLS.has(tool.name) && !failed) {
      const f = pick(params, ['targetFile', 'target_file', 'relativeWorkspacePath', 'filePath', 'file_path', 'path', 'file']);
      if (f) c.changedFiles.add(f);
    }
    if (SHELL_TOOLS.has(tool.name)) {
      const id = tool.toolCallId || b.bubbleId || `${c.commands.length}`;
      onShell(c, id, pick(params, ['command', 'cmd']));
      const result = parseJson(tool.result) || {};
      const out = typeof result.output === 'string' ? result.output : typeof tool.result === 'string' ? tool.result : '';
      const code = result.exitCode ?? result.exit_code;
      if (status || tool.result) onShellResult(c, id, out, failed || (typeof code === 'number' && code !== 0), at ? new Date(at).toISOString() : null);
    }
  }
  if (!c.timestamps.length) {
    // 古い形式でバブルに時刻が無いときは、チャットの作成・更新時刻だけを使う
    addTime(c, composer?.createdAt);
    addTime(c, composer?.lastUpdatedAt);
  }
  return finish(c, { tool: 'cursor', id: String(composer?.composerId || file.split('#').pop()), file, cwd, project: 'cursor', title: typeof composer?.name === 'string' ? composer.name : null });
}

// DB から1つのチャットを読む
export function readComposer(db, composerId) {
  const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${composerId}`);
  const composer = row && parseJson(row.value);
  if (!composer) throw new Error(`チャット ${composerId} が見つかりません`);
  if (Array.isArray(composer.conversation) && composer.conversation.length) return { composer, bubbles: composer.conversation };
  const prefix = `bubbleId:${composerId}:`;
  // キーの範囲で引く(LIKE よりインデックスが効く)。";" は ":" の次の文字
  const rows = db.prepare('SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?').all(prefix, `bubbleId:${composerId};`);
  const byId = new Map();
  for (const r of rows) {
    const b = parseJson(r.value);
    if (b) byId.set(r.key.slice(prefix.length), b);
  }
  const headers = Array.isArray(composer.fullConversationHeadersOnly) ? composer.fullConversationHeadersOnly : [];
  let bubbles = headers.map((h) => byId.get(h?.bubbleId)).filter(Boolean);
  // 見出しが無い(または一致しない)ときは時刻順
  if (!bubbles.length) bubbles = [...byId.values()].sort((a, b) => (bubbleTime(a) || 0) - (bubbleTime(b) || 0));
  return { composer, bubbles };
}

// ワークスペースごとのチャットID -> プロジェクトのパス(DB の更新時刻で覚えておく)
const workspaceCache = new Map(); // db -> { mtimeMs, folder, ids }

async function workspaceMap(dir) {
  const root = path.join(dir, 'workspaceStorage');
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return new Map();
  }
  const map = new Map();
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const db = path.join(root, e.name, 'state.vscdb');
    let st;
    try {
      st = await stat(db);
    } catch {
      continue;
    }
    let hit = workspaceCache.get(db);
    if (!hit || hit.mtimeMs !== st.mtimeMs) {
      const ws = parseJson(await readFile(path.join(root, e.name, 'workspace.json'), 'utf8').catch(() => null)) || {};
      let ids = [];
      try {
        ids = await withDb(db, (d) => {
          const row = d.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get();
          const j = row && parseJson(row.value);
          return (Array.isArray(j?.allComposers) ? j.allComposers : []).map((x) => x?.composerId).filter((x) => typeof x === 'string');
        });
      } catch {
        // 壊れた・古い形式の DB は飛ばす
      }
      hit = { mtimeMs: st.mtimeMs, folder: uriToPath(ws.folder) || uriToPath(ws.workspace), ids };
      workspaceCache.set(db, hit);
    }
    if (hit.folder) for (const id of hit.ids) map.set(id, hit.folder);
  }
  return map;
}

const toMs = (v) => (typeof v === 'number' ? v : /^\d+$/.test(String(v ?? '')) ? Number(v) : Date.parse(v) || 0);

// 1チャットごとに1件。file は "<state.vscdb>#<composerId>"(仮想のキー)、mtimeMs / size はチャットの更新時刻とデータ量
const listCache = { key: null, rows: [] };

export async function listCursor(dir) {
  const db = path.join(dir, 'globalStorage', 'state.vscdb');
  let st;
  try {
    st = await stat(db);
  } catch {
    return [];
  }
  const wal = await stat(db + '-wal').catch(() => null);
  const key = `${db}|${st.mtimeMs}|${st.size}|${wal?.mtimeMs}|${wal?.size}`;
  if (listCache.key !== key) {
    listCache.rows = await withDb(db, (d) =>
      d
        .prepare(
          `SELECT substr(key, 14) AS id, length(value) AS size,
             json_extract(CAST(value AS TEXT), '$.lastUpdatedAt') AS updated,
             json_extract(CAST(value AS TEXT), '$.createdAt') AS created,
             COALESCE(json_array_length(CAST(value AS TEXT), '$.fullConversationHeadersOnly'), 0)
               + COALESCE(json_array_length(CAST(value AS TEXT), '$.conversation'), 0) AS n
           FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;' AND json_valid(CAST(value AS TEXT))`,
        )
        .all(),
    );
    listCache.key = key;
  }
  const folders = await workspaceMap(dir);
  return listCache.rows
    .filter((r) => r.n > 0) // 開いただけで何も話していないチャットは除く
    .map((r) => ({
      file: `${db}#${r.id}`,
      db,
      composerId: r.id,
      cwd: folders.get(r.id) || null,
      mtimeMs: toMs(r.updated) || toMs(r.created) || st.mtimeMs,
      size: Number(r.size) || 0,
    }));
}

export async function parseCursorFile(file, entry = {}) {
  const i = file.lastIndexOf('#');
  const db = entry.db || file.slice(0, i);
  const composerId = entry.composerId || file.slice(i + 1);
  const { composer, bubbles } = await withDb(db, (d) => readComposer(d, composerId));
  let cwd = entry.cwd;
  if (cwd === undefined) cwd = (await workspaceMap(path.dirname(path.dirname(db)))).get(composerId) || null;
  return parseCursorComposer(composer, bubbles, { file, cwd });
}
