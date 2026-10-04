// Claude Code 以外のツールのログを、parser.js と同じ形のセッションレコードにまとめるための共通部品。
// 各取り込み元(gemini.js / copilot.js / aider.js / cursor.js)は、ログから collector に材料を積み、finish() でレコードにする。
import { clipMasked } from './mask.js';
import path from 'node:path';
import { buildSegments, gitCommandKind, parseCommitOutput, projectNameFrom } from './parser.js';

export function createCollector() {
  return {
    prompts: [],
    assistantTexts: [],
    assistantMessages: 0,
    timestamps: [],
    toolCalls: {},
    changedFiles: new Set(),
    commands: [],
    commitAttempts: 0,
    commits: new Map(), // hash -> { hash, branch, subject, at }
    quietCommits: [],
    pushes: 0,
    models: new Set(),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    usage: {}, // "時(UTC)|モデル||" -> [input, output, cacheRead, cacheWrite5m, cacheWrite1h, webSearches]
    gitCalls: new Map(), // ツール呼び出しID -> { commit, push }
    gitDone: new Set(),
  };
}

// 時刻(ミリ秒 / ISO文字列 / Date)を足す。読めない値は無視する
export function addTime(c, t) {
  const ms = typeof t === 'number' ? t : t instanceof Date ? t.getTime() : /^\d{12,}$/.test(String(t ?? '')) ? Number(t) : Date.parse(t);
  if (Number.isFinite(ms) && ms > 0) c.timestamps.push(ms);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export function countTool(c, name) {
  if (name) c.toolCalls[name] = (c.toolCalls[name] || 0) + 1;
}

// シェルコマンドの実行。結果が別に届く場合は callId で結び付ける
export function onShell(c, callId, command) {
  if (typeof command !== 'string' || !command.trim()) return;
  c.commands.push(command);
  const kind = gitCommandKind(command);
  if (kind.commit) c.commitAttempts++;
  if (callId && (kind.commit || kind.push)) c.gitCalls.set(callId, kind);
}

// シェルコマンドの結果。成功した git commit / push だけを数える
export function onShellResult(c, callId, text, failed, at) {
  const kind = c.gitCalls.get(callId);
  if (!kind || c.gitDone.has(callId)) return;
  c.gitDone.add(callId);
  if (kind.push && !failed) c.pushes++;
  if (kind.commit) {
    const found = parseCommitOutput(String(text || ''));
    for (const cm of found) if (!c.commits.has(cm.hash)) c.commits.set(cm.hash, { ...cm, at: at || null });
    if (!found.length && !failed && at) c.quietCommits.push(at);
  }
}

// 利用量を1時間・モデル単位で積む。u: { input, output, cacheRead, cacheWrite }(input はキャッシュ分を除いた値)
export function addUsage(c, at, model, u) {
  const input = Math.max(0, u.input || 0);
  const output = Math.max(0, u.output || 0);
  const cacheRead = Math.max(0, u.cacheRead || 0);
  const cacheWrite = Math.max(0, u.cacheWrite || 0);
  c.tokens.input += input;
  c.tokens.output += output;
  c.tokens.cacheRead += cacheRead;
  c.tokens.cacheCreation += cacheWrite;
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!model || !Number.isFinite(ms)) return;
  const key = `${new Date(ms).toISOString().slice(0, 13)}|${model}||`;
  const row = c.usage[key] || [0, 0, 0, 0, 0, 0];
  row[0] += input;
  row[1] += output;
  row[2] += cacheRead;
  row[3] += cacheWrite;
  c.usage[key] = row;
}

function titleOf(text) {
  const line = (text || '').split('\n').find((l) => l.trim()) || '';
  const clean = line.replace(/^\s*(?:#{1,6}\s+|>\s*)/, '').replace(/[*`]/g, '').trim();
  return clipMasked(clean, 60);
}

// collector をセッションレコードにする(parser.js / codex.js と同じ形)
export function finish(c, { tool, id, file, cwd = null, project = null, gitBranch = null, repoUrl = null, title = null }) {
  const ts = [...c.timestamps].sort((a, b) => a - b);
  const segments = buildSegments(ts);
  const changedFiles = [...c.changedFiles].map((f) => (cwd && f.startsWith(cwd + '/') ? f.slice(cwd.length + 1) : f));
  const prompts = c.prompts;
  return {
    tool,
    id,
    file,
    projectDir: cwd ? path.basename(cwd) : project || '',
    project: cwd ? projectNameFrom(cwd, '') : project || 'unknown',
    cwd,
    gitBranch,
    repoUrl,
    title: titleOf(title) || titleOf(prompts[0]) || '(無題のセッション)',
    firstPrompt: prompts[0] ? prompts[0].slice(0, 2000) : null,
    prompts: prompts.map((p) => p.slice(0, 1000)),
    lastAssistantText: c.assistantTexts.length ? c.assistantTexts[c.assistantTexts.length - 1].slice(0, 2000) : null,
    assistantTexts: c.assistantTexts.map((x) => x.slice(0, 600)),
    start: ts.length ? new Date(ts[0]).toISOString() : null,
    end: ts.length ? new Date(ts[ts.length - 1]).toISOString() : null,
    segments,
    activeMs: segments.reduce((sum, g) => sum + (Date.parse(g.end) - Date.parse(g.start)), 0),
    userMessages: prompts.length,
    assistantMessages: c.assistantMessages,
    messageCount: prompts.length + c.assistantMessages,
    toolCalls: c.toolCalls,
    changedFiles,
    commands: c.commands.slice(-50).map((x) => x.slice(0, 300)),
    commits: c.commits.size + c.quietCommits.length,
    commitList: [...c.commits.values()],
    quietCommits: c.quietCommits,
    commitAttempts: c.commitAttempts,
    pushes: c.pushes,
    models: [...c.models],
    tokens: c.tokens,
    usage: c.usage,
    estimatedOutputTokens: 0,
  };
}
