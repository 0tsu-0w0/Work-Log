// GitHub Copilot CLI のセッションログを、Claude Code と同じ形の集計レコードに変換する。
// 形式は @github/copilot の同梱スキーマ schemas/session-events.schema.json と app.js(1.0.63 で確認)に合わせている:
//   保存先 $COPILOT_HOME(既定 ~/.copilot)/session-state/<セッションID>/events.jsonl と workspace.yaml
//     events.jsonl は1行1イベント {id, timestamp, parentId, type, data}。
//     session.start / session.resume(data.context に cwd・branch・repository)、user.message、assistant.message
//     (content・model・toolRequests・outputTokens)、tool.execution_start / tool.execution_complete、
//     session.shutdown(その起動中のモデルごとの利用量 modelMetrics)など。
//     assistant.usage(応答ごとの利用量)や title_changed は ephemeral(ファイルに残らない)なので使えない
//     workspace.yaml は id / cwd / git_root / repository / branch / name / summary / created_at / updated_at
//   0.0.3xx までの版は history-session-state/session_<ID>_<開始ミリ秒>.json に
//     {sessionId, startTime, chatMessages, timeline: [{id, timestamp, type: user|copilot|tool_call_requested|tool_call_completed|info|error, …}], selectedModel}
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { addTime, addUsage, countTool, createCollector, finish, onShell, onShellResult } from './record.js';

const SHELL_TOOLS = new Set(['bash', 'powershell', 'shell']);
const EDIT_TOOLS = new Set(['edit', 'create', 'str_replace', 'str_replace_editor', 'write', 'apply_patch']);

// "claude-sonnet-4.5" のような Copilot の表記を、単価表の "claude-sonnet-4-5" にそろえる
export function normalizeModel(model) {
  if (typeof model !== 'string' || !model) return null;
  return model.replace(/^(claude-[a-z]+-\d+)\.(\d+)/, '$1-$2');
}

// repository は "owner/name" の形。webBaseFromRemote が読める URL にする
function repoUrlOf(repo, host) {
  if (!repo) return null;
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) return `https://${host && !host.includes('/') ? host : 'github.com'}/${repo}`;
  return repo;
}

function parseArgs(a) {
  if (typeof a === 'string') {
    try {
      return JSON.parse(a);
    } catch {
      return { command: a };
    }
  }
  return a && typeof a === 'object' ? a : {};
}

// workspace.yaml(平らな key: value だけを読む)
export function parseWorkspaceYaml(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      try {
        v = v.startsWith('"') ? JSON.parse(v) : v.slice(1, -1).replace(/''/g, "'");
      } catch {
        v = v.slice(1, -1);
      }
    }
    out[m[1]] = v;
  }
  return out;
}

export function parseCopilotEvents(text, { file = '', workspace = {} } = {}) {
  const c = createCollector();
  let id = workspace.id || path.basename(path.dirname(file));
  let cwd = null;
  let branch = null;
  let repo = null;
  let repoHost = null;
  let model = null;
  const tools = new Map(); // toolCallId -> { name, args }
  // 起動(session.start / resume)ごとに、shutdown の利用量か、無ければ応答の outputTokens を使う
  let run = { shutdown: false, output: {} };
  const runs = [run];

  const ctx = (x) => {
    if (!x || typeof x !== 'object') return;
    if (x.cwd) cwd = String(x.cwd);
    if (x.branch) branch = String(x.branch);
    if (x.repository) repo = String(x.repository);
    if (x.repositoryHost) repoHost = String(x.repositoryHost);
  };
  const toolOf = (callId, name, args) => {
    const t = tools.get(callId) || {};
    tools.set(callId, { name: name || t.name, args: args ?? t.args });
  };

  for (const line of text.split('\n')) {
    if (!line.trim() || /^[\u0000\s]*$/.test(line)) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const d = e?.data || {};
    const ts = e?.timestamp;
    switch (e?.type) {
      case 'session.start':
        if (d.sessionId) id = String(d.sessionId);
        ctx(d.context);
        model = normalizeModel(d.selectedModel) || model;
        if (run.shutdown || Object.keys(run.output).length) runs.push((run = { shutdown: false, output: {} }));
        break;
      case 'session.resume':
        ctx(d.context);
        model = normalizeModel(d.selectedModel) || model;
        runs.push((run = { shutdown: false, output: {} }));
        break;
      case 'session.context_changed':
        ctx(d);
        break;
      case 'session.model_change':
        model = normalizeModel(d.newModel) || model;
        break;
      case 'user.message': {
        addTime(c, ts);
        const body = typeof d.content === 'string' ? d.content.trim() : '';
        if (body && !d.isAutopilotContinuation && !d.parentAgentTaskId) c.prompts.push(body);
        break;
      }
      case 'assistant.message': {
        addTime(c, ts);
        const m = normalizeModel(d.model) || model;
        if (m) c.models.add(m);
        const body = typeof d.content === 'string' ? d.content.trim() : '';
        const reqs = Array.isArray(d.toolRequests) ? d.toolRequests : [];
        if (!d.parentToolCallId && (body || reqs.length)) c.assistantMessages++;
        if (body && !d.parentToolCallId) c.assistantTexts.push(body);
        for (const r of reqs) if (r?.toolCallId) toolOf(r.toolCallId, r.name, parseArgs(r.arguments));
        if (m && d.outputTokens > 0) run.output[`${m}\n${ts}`] = d.outputTokens;
        break;
      }
      case 'tool.execution_start':
        addTime(c, ts);
        if (d.toolCallId) toolOf(d.toolCallId, d.toolName, d.arguments !== undefined ? parseArgs(d.arguments) : undefined);
        break;
      case 'tool.execution_complete': {
        addTime(c, ts);
        const t = tools.get(d.toolCallId) || {};
        t.done = { success: d.success !== false, text: [d.result?.content, d.result?.detailedContent, d.error?.message].filter((x) => typeof x === 'string').join('\n'), ts };
        let files = [];
        try {
          files = JSON.parse(d.toolTelemetry?.restrictedProperties?.filePaths || '[]');
        } catch {
          // 無ければ引数の path を使う
        }
        t.files = Array.isArray(files) ? files.filter((f) => typeof f === 'string') : [];
        tools.set(d.toolCallId, t);
        break;
      }
      case 'session.shutdown': {
        addTime(c, ts);
        run.shutdown = true;
        for (const [name, metric] of Object.entries(d.modelMetrics || {})) {
          const u = metric?.usage || {};
          const m = normalizeModel(name);
          if (m) c.models.add(m);
          // inputTokens はキャッシュ読み込みを含む(OpenAI 形式)とみなして差し引く。出力は推論トークンを含む
          addUsage(c, ts, m, { input: (u.inputTokens || 0) - (u.cacheReadTokens || 0), output: u.outputTokens || 0, cacheRead: u.cacheReadTokens || 0, cacheWrite: u.cacheWriteTokens || 0 });
        }
        for (const f of d.codeChanges?.filesModified || []) if (typeof f === 'string') c.changedFiles.add(f);
        break;
      }
      case 'abort':
      case 'session.error':
      case 'session.task_complete':
        addTime(c, ts);
        break;
    }
  }

  // shutdown の無い起動(強制終了・実行中)は、応答ごとの出力トークンだけを数える
  for (const r of runs) {
    if (r.shutdown) continue;
    for (const [k, n] of Object.entries(r.output)) {
      const [m, ts] = k.split('\n');
      addUsage(c, ts, m, { output: n });
    }
  }

  for (const [callId, t] of tools) {
    if (!t.name) continue;
    countTool(c, t.name);
    const args = t.args || {};
    if (EDIT_TOOLS.has(t.name) && (!t.done || t.done.success)) {
      for (const f of t.files?.length ? t.files : [args.path, args.file_path].filter((x) => typeof x === 'string')) c.changedFiles.add(f);
    }
    if (SHELL_TOOLS.has(t.name)) {
      onShell(c, callId, args.command);
      if (t.done) onShellResult(c, callId, t.done.text, !t.done.success || /<exited with exit code [1-9]\d*>/.test(t.done.text), t.done.ts || null);
    }
  }

  return finish(c, {
    tool: 'copilot',
    id,
    file,
    cwd: cwd || workspace.cwd || null,
    gitBranch: branch || workspace.branch || null,
    repoUrl: repoUrlOf(repo || workspace.repository, repoHost),
    title: workspace.name || workspace.summary || null,
  });
}

// 0.0.3xx までの history-session-state/session_<ID>_<ミリ秒>.json
export function parseCopilotLegacy(json, { file = '' } = {}) {
  const c = createCollector();
  const m = path.basename(file).match(/^session_(.+)_(\d+)\.json$/);
  const model = normalizeModel(json?.selectedModel);
  if (model) c.models.add(model);
  const tools = new Map();
  for (const e of Array.isArray(json?.timeline) ? json.timeline : []) {
    if (!e || typeof e !== 'object') continue;
    addTime(c, e.timestamp);
    const text = typeof e.text === 'string' ? e.text.trim() : '';
    if (e.type === 'user' && text) c.prompts.push(text);
    else if (e.type === 'copilot' && text) {
      c.assistantMessages++;
      c.assistantTexts.push(text);
    } else if (e.type === 'tool_call_requested' || e.type === 'tool_call_completed') {
      const t = tools.get(e.callId) || {};
      t.name = e.name || t.name;
      t.args = parseArgs(e.arguments ?? t.args);
      if (e.type === 'tool_call_completed') t.result = { ok: e.result?.type === 'success', log: e.result?.log || '', ts: e.timestamp };
      tools.set(e.callId, t);
    }
  }
  for (const [callId, t] of tools) {
    countTool(c, t.name);
    if (EDIT_TOOLS.has(t.name) && t.args?.command !== 'view' && typeof t.args?.path === 'string' && (!t.result || t.result.ok)) c.changedFiles.add(t.args.path);
    if (SHELL_TOOLS.has(t.name)) {
      onShell(c, callId, t.args?.command);
      if (t.result) onShellResult(c, callId, t.result.log, !t.result.ok || /<exited with exit code [1-9]\d*>/.test(t.result.log), t.result.ts || null);
    }
  }
  if (!c.timestamps.length) addTime(c, json?.startTime);
  return finish(c, { tool: 'copilot', id: String(json?.sessionId || m?.[1] || path.basename(file, '.json')), file });
}

async function readdirSafe(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function listCopilot(dir) {
  const out = [];
  const state = path.join(dir, 'session-state');
  for (const e of await readdirSafe(state)) {
    // 旧形式の平らな <ID>.jsonl は Copilot CLI 自身も読まない(移行済み)ので扱わない
    if (e.isDirectory()) out.push({ file: path.join(state, e.name, 'events.jsonl') });
  }
  const legacy = path.join(dir, 'history-session-state');
  for (const e of await readdirSafe(legacy)) {
    if (e.isFile() && /^session_.+_\d+\.json$/.test(e.name)) out.push({ file: path.join(legacy, e.name) });
  }
  return out;
}

export async function parseCopilotFile(file) {
  if (file.endsWith('.json')) return parseCopilotLegacy(JSON.parse(await readFile(file, 'utf8')), { file });
  let workspace = {};
  try {
    workspace = parseWorkspaceYaml(await readFile(path.join(path.dirname(file), 'workspace.yaml'), 'utf8'));
  } catch {
    // 無くてもよい
  }
  return parseCopilotEvents(await readFile(file, 'utf8'), { file, workspace });
}
