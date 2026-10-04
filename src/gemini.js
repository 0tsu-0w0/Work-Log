// Gemini CLI のセッションログを、Claude Code と同じ形の集計レコードに変換する。
// 形式は google-gemini/gemini-cli の packages/core(services/chatRecordingService・chatRecordingTypes・config/storage・
// config/projectRegistry)に合わせている(@google/gemini-cli-core 0.62 で確認):
//   保存先 $GEMINI_CLI_HOME(既定 ~)/.gemini/tmp/<プロジェクトID>/chats/session-<時刻>-<ID先頭8文字>.jsonl
//     1行目がメタ情報 {sessionId, projectHash, startTime, lastUpdated, kind}、以降はメッセージ
//     {id, timestamp, type: user|gemini|info|error|warning, content, toolCalls, tokens, model}。
//     同じ id のメッセージは更新のたびに丸ごと追記される(後の行が正)。{"$set": {...}} はメタ情報の更新、{"$rewindTo": id} は巻き戻し
//   古い版は session-*.json に ConversationRecord({..., messages: [...]})を1つの JSON で書く
//   サブエージェントは chats/<親セッションID>/<ID>.jsonl
//   <プロジェクトID> は新しい版ではフォルダ名から作った短い名前(projects.json と .project_root で実際のパスと対応付く)、
//   古い版ではプロジェクトの絶対パスの sha256
// tmp/<プロジェクトID>/logs.json は入力した依頼だけの記録(応答・時刻の幅が無い)。chats が無いセッションだけ補助的に使う
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { addTime, addUsage, countTool, createCollector, finish, onShell, onShellResult } from './record.js';

const SHELL_TOOLS = new Set(['run_shell_command']);
const EDIT_TOOLS = new Set(['write_file', 'replace', 'edit']);
// gemini-cli の isIgnoredUserContent と同じ: スラッシュコマンドや差し込まれた文脈は依頼として数えない
const IGNORED_PREFIXES = ['/', '?', '<session_context>', '<hook_context>'];

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// PartListUnion(文字列 / {text} / その配列)からテキストを取り出す
export function partsText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(partsText).join('');
  if (content && typeof content === 'object' && typeof content.text === 'string' && !content.thought) return content.text;
  return '';
}

// ツールの結果(functionResponse.response.output など)の文字列
function resultText(call) {
  const out = [];
  const visit = (p) => {
    if (!p) return;
    if (typeof p === 'string') out.push(p);
    else if (Array.isArray(p)) p.forEach(visit);
    else if (typeof p === 'object') {
      if (typeof p.text === 'string') out.push(p.text);
      const r = p.functionResponse?.response;
      if (r) out.push(typeof r.output === 'string' ? r.output : typeof r.error === 'string' ? r.error : '');
    }
  };
  visit(call.result);
  if (!out.join('').trim() && typeof call.resultDisplay === 'string') out.push(call.resultDisplay);
  // シェルの結果は "Output: <出力>\nExit Code: 1" の形。行頭の "Output: " を外して git commit の出力行を読めるようにする
  return out.join('\n').replace(/^Output: /gm, '');
}

// JSONL(新形式)と JSON(旧形式)のどちらも ConversationRecord に読む。
// 巻き戻し($rewindTo)で消されたメッセージも、実際に作業した時間と利用量なので残す
export function readConversation(text) {
  const meta = {};
  const messages = new Map();
  const addMessages = (list) => {
    for (const m of Array.isArray(list) ? list : []) if (m && typeof m.id === 'string') messages.set(m.id, { ...messages.get(m.id), ...m });
  };
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && !trimmed.includes('\n{')) {
    // 旧形式(1つの JSON)。書き込み途中で壊れていれば JSONL として読み直す
    try {
      const j = JSON.parse(trimmed);
      const { messages: list, ...rest } = j;
      Object.assign(meta, rest);
      addMessages(list);
      return { meta, messages: [...messages.values()] };
    } catch {
      // 下へ
    }
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // 書き込み途中の行など
    }
    if (!r || typeof r !== 'object') continue;
    if (typeof r.$rewindTo === 'string') continue;
    if (r.$set && typeof r.$set === 'object') {
      const { messages: list, ...rest } = r.$set;
      Object.assign(meta, rest);
      addMessages(list);
    } else if (typeof r.id === 'string') {
      addMessages([r]);
    } else if (typeof r.sessionId === 'string') {
      const { messages: list, ...rest } = r;
      Object.assign(meta, rest);
      addMessages(list);
    }
  }
  return { meta, messages: [...messages.values()] };
}

// プロジェクトのパスを探す。ctx: { projectId, rootMarker, registry: {パス: 短い名前} }
export function resolveProjectRoot({ projectId = '', rootMarker = null, registry = {}, projectHash = null, candidates = [] } = {}) {
  if (rootMarker) return rootMarker;
  for (const [p, id] of Object.entries(registry)) if (id === projectId) return p;
  const hashes = new Set([projectHash, /^[0-9a-f]{64}$/.test(projectId) ? projectId : null].filter(Boolean));
  if (!hashes.size) return null;
  for (const p of Object.keys(registry)) if (hashes.has(sha256(p))) return p;
  // 旧形式(ハッシュのフォルダ)は、ツールの引数にある絶対パスを上へたどって sha256 が一致するフォルダを探す
  const tried = new Set();
  for (const c of candidates) {
    let d = c;
    while (d && path.isAbsolute(d) && !tried.has(d)) {
      tried.add(d);
      if (hashes.has(sha256(d))) return d;
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return null;
}

function absPathsIn(value, out = []) {
  if (typeof value === 'string') {
    if (path.isAbsolute(value) && !value.includes('\n') && value.length < 1024) out.push(value);
  } else if (Array.isArray(value)) value.forEach((v) => absPathsIn(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => absPathsIn(v, out));
  return out;
}

export function parseGeminiText(text, { file = '', projectId = '', rootMarker = null, registry = {} } = {}) {
  const { meta, messages } = readConversation(text);
  const c = createCollector();
  const candidates = [...(Array.isArray(meta.directories) ? meta.directories : [])];
  messages.sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0));

  for (const m of messages) {
    const at = addTime(c, m.timestamp);
    if (m.type === 'user') {
      const body = partsText(m.content).trim();
      if (body && !IGNORED_PREFIXES.some((p) => body.startsWith(p))) c.prompts.push(body);
      continue;
    }
    if (m.type !== 'gemini') continue;
    const body = partsText(m.content).trim();
    const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    if (body || calls.length) c.assistantMessages++;
    if (body) c.assistantTexts.push(body);
    if (typeof m.model === 'string' && m.model) c.models.add(m.model);
    for (const t of Array.isArray(m.thoughts) ? m.thoughts : []) addTime(c, t?.timestamp);
    for (const call of calls) {
      if (!call || typeof call.name !== 'string') continue;
      const callAt = addTime(c, call.timestamp) ?? at;
      countTool(c, call.name);
      const args = call.args && typeof call.args === 'object' ? call.args : {};
      absPathsIn(args, candidates);
      if (EDIT_TOOLS.has(call.name) && typeof args.file_path === 'string' && call.status !== 'error' && call.status !== 'cancelled') c.changedFiles.add(args.file_path);
      if (SHELL_TOOLS.has(call.name)) {
        const id = call.id || `${m.id}:${call.name}:${c.commands.length}`;
        onShell(c, id, args.command);
        const out = resultText(call);
        const failed = call.status === 'error' || call.status === 'cancelled' || /^Exit Code: [1-9]/m.test(out);
        onShellResult(c, id, out, failed, callAt ? new Date(callAt).toISOString() : null);
      }
    }
    // tokens: promptTokenCount はキャッシュ分を含む。出力は candidates + thoughts(思考も出力として課金される)
    const tk = m.tokens;
    if (tk && typeof tk === 'object') {
      const cached = tk.cached || 0;
      addUsage(c, at, m.model, { input: (tk.input || 0) - cached + (tk.tool || 0), output: (tk.output || 0) + (tk.thoughts || 0), cacheRead: cached });
    }
  }
  if (!c.timestamps.length) {
    // メッセージに時刻が無い(作っただけのセッション)
    addTime(c, meta.startTime);
  }
  const cwd = resolveProjectRoot({ projectId, rootMarker, registry, projectHash: meta.projectHash, candidates });
  const id = String(meta.sessionId || path.basename(file).replace(/\.jsonl?$/, ''));
  return finish(c, { tool: 'gemini', id, file, cwd, project: projectId && !/^[0-9a-f]{64}$/.test(projectId) ? projectId : `gemini-${(meta.projectHash || projectId || 'unknown').slice(0, 8)}`, title: typeof meta.summary === 'string' ? meta.summary : null });
}

// logs.json(依頼だけの記録)の1セッション分
export function parseGeminiLogs(entries, { file = '', sessionId, projectId = '', rootMarker = null, registry = {} } = {}) {
  const c = createCollector();
  for (const e of entries) {
    if (e?.sessionId !== sessionId || e.type !== 'user' || typeof e.message !== 'string') continue;
    addTime(c, e.timestamp);
    const body = e.message.trim();
    if (body && !IGNORED_PREFIXES.some((p) => body.startsWith(p))) c.prompts.push(body);
  }
  const cwd = resolveProjectRoot({ projectId, rootMarker, registry });
  return finish(c, { tool: 'gemini', id: sessionId, file, cwd, project: projectId && !/^[0-9a-f]{64}$/.test(projectId) ? projectId : `gemini-${projectId.slice(0, 8)}` });
}

async function readJsonSafe(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function readdirSafe(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// <dir>/tmp/<プロジェクトID>/chats/ の下のセッションと、chats が無いセッションの logs.json
export async function listGemini(dir) {
  const tmp = path.join(dir, 'tmp');
  const out = [];
  for (const p of await readdirSafe(tmp)) {
    if (!p.isDirectory() || p.name === 'bin') continue;
    const projectId = p.name;
    const chats = path.join(tmp, projectId, 'chats');
    const ids8 = new Set();
    const entries = await readdirSafe(chats);
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    for (const e of entries) {
      if (e.isFile() && /^session-.*\.jsonl?$/.test(e.name)) {
        // 再開時に .json は .jsonl へ移し替えられる。両方あれば .jsonl を使う
        if (e.name.endsWith('.json') && names.has(e.name + 'l')) continue;
        ids8.add(e.name.replace(/\.jsonl?$/, '').slice(-8));
        out.push({ file: path.join(chats, e.name), projectId });
      } else if (e.isDirectory()) {
        // サブエージェント: chats/<親セッションID>/<ID>.jsonl(利用量だけ親に合算する)
        for (const s of await readdirSafe(path.join(chats, e.name))) {
          if (s.isFile() && s.name.endsWith('.jsonl')) out.push({ file: path.join(chats, e.name, s.name), projectId, parentId: e.name });
        }
      }
    }
    const logs = await readJsonSafe(path.join(tmp, projectId, 'logs.json'));
    if (Array.isArray(logs)) {
      const seen = new Set();
      for (const l of logs) {
        const sid = l?.sessionId;
        if (typeof sid !== 'string' || seen.has(sid) || ids8.has(sid.slice(0, 8))) continue;
        seen.add(sid);
        out.push({ file: `${path.join(tmp, projectId, 'logs.json')}#${sid}`, statFile: path.join(tmp, projectId, 'logs.json'), projectId, sessionId: sid });
      }
    }
  }
  return out;
}

async function projectContext(dir, projectId) {
  let rootMarker = null;
  try {
    rootMarker = (await readFile(path.join(dir, 'tmp', projectId, '.project_root'), 'utf8')).trim() || null;
  } catch {
    // 古い版には無い
  }
  const reg = await readJsonSafe(path.join(dir, 'projects.json'));
  const registry = reg && typeof reg.projects === 'object' && reg.projects ? reg.projects : {};
  return { projectId, rootMarker, registry };
}

// file: chats のファイル、または "<logs.json>#<セッションID>"
export async function parseGeminiFile(file, entry = {}) {
  const real = file.replace(/#[^/\\]*$/, '');
  const sessionId = entry.sessionId || (real !== file ? file.slice(real.length + 1) : null);
  // <dir>/tmp/<プロジェクトID>/chats/[<親ID>/]<ファイル> または <dir>/tmp/<プロジェクトID>/logs.json
  let projDir = path.dirname(real);
  if (!sessionId) projDir = path.dirname(entry.parentId ? path.dirname(projDir) : projDir);
  const ctx = await projectContext(path.dirname(path.dirname(projDir)), entry.projectId || path.basename(projDir));
  if (sessionId) {
    const logs = JSON.parse(await readFile(real, 'utf8'));
    return parseGeminiLogs(Array.isArray(logs) ? logs : [], { file, sessionId, ...ctx });
  }
  return parseGeminiText(await readFile(file, 'utf8'), { file, ...ctx });
}
