// Claude Code のセッションログ(JSONL)を1セッション分の集計レコードに変換する。
import { clipMasked } from './mask.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// この時間以上アクティビティが空いたら、カレンダー上で別ブロックに分ける
export const SEGMENT_GAP_MS = 30 * 60 * 1000;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// コマンドの先頭か、&& ; || | ( の直後に現れる git だけを数える
const GIT_COMMIT_RE = /(?:^|[;&|(\n])\s*git\s+(?:-[cC]\s+\S+\s+)*commit\b/;
const GIT_PUSH_RE = /(?:^|[;&|(\n])\s*git\s+(?:-[cC]\s+\S+\s+)*push\b/;
// ヒアドキュメントの本文(スクリプトやコミットメッセージ)の中の "git commit" は実行ではない
const HEREDOC_RE = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s*$|\n)/gm;

export function gitCommandKind(command) {
  const cmd = command.replace(HEREDOC_RE, '');
  return { commit: GIT_COMMIT_RE.test(cmd), push: GIT_PUSH_RE.test(cmd) };
}
// git commit の出力 "[main 1a2b3c4] メッセージ"、"[main (root-commit) 1a2b3c4] …"、"[detached HEAD 1a2b3c4] …"
const COMMIT_LINE_RE = /^\[(.+?) ([0-9a-f]{7,40})\] (.*)$/gm;

export function parseCommitOutput(text) {
  const out = [];
  for (const m of text.matchAll(COMMIT_LINE_RE)) {
    out.push({ hash: m[2], branch: m[1].replace(/ \(root-commit\)$/, ''), subject: m[3].trim() });
  }
  return out;
}

function toolResultText(c) {
  if (typeof c.content === 'string') return c.content;
  return Array.isArray(c.content) ? c.content.filter((x) => x?.type === 'text').map((x) => x.text).join('\n') : '';
}

const NOISE_PREFIXES = ['<command-', '<local-command-', '<system-reminder>', 'Caveat:', '[Request interrupted'];

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
}

function isRealPrompt(entry) {
  if (entry.isMeta || entry.isSidechain) return false;
  const content = entry.message?.content;
  if (Array.isArray(content) && content.some((c) => c?.type === 'tool_result')) return false;
  const text = textOf(content).trim();
  if (!text) return false;
  return !NOISE_PREFIXES.some((p) => text.startsWith(p));
}

// "/home/me/src/app" -> "app"、ディレクトリ名 "-home-me-src-app" しかない場合はその末尾
export function projectNameFrom(cwd, projectDir) {
  if (cwd) return path.basename(cwd) || cwd;
  const dir = path.basename(projectDir || '');
  return dir.split('-').filter(Boolean).pop() || dir || 'unknown';
}

export function buildSegments(timestamps, gapMs = SEGMENT_GAP_MS) {
  const ts = [...timestamps].sort((a, b) => a - b);
  const segments = [];
  for (const t of ts) {
    const last = segments[segments.length - 1];
    if (last && t - last.end <= gapMs) last.end = t;
    else segments.push({ start: t, end: t });
  }
  return segments.map((s) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() }));
}

export function parseSessionText(text, { file = '', projectDir = '' } = {}) {
  const s = {
    id: path.basename(file, '.jsonl'),
    file,
    projectDir: path.basename(projectDir),
    cwd: null,
    gitBranch: null,
    title: null,
    summaryLine: null,
    prompts: [],
    assistantTexts: [],
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: {},
    changedFiles: new Set(),
    commands: [],
    commitAttempts: 0,
    commits: new Map(), // hash -> { hash, branch, subject, at }
    quietCommits: [], // 成功したがハッシュが出力されなかった(-q など)コミットの時刻
    pushes: 0,
    models: new Set(),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    usage: new Map(), // "時(UTC)|モデル|fast|us" -> [input, output, cacheRead, cacheWrite5m, cacheWrite1h, webSearches]
  };
  const timestamps = [];
  const seenMessageIds = new Set();
  const gitToolUses = new Map(); // tool_use id -> { commit, push }
  const msgUsage = new Map(); // message.id -> { timestamp, model, u }

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // 書き込み途中の行など
    }
    if (e.sessionId && !s.id) s.id = e.sessionId;
    if (e.cwd && !s.cwd) s.cwd = e.cwd;
    if (e.gitBranch) s.gitBranch = e.gitBranch;
    if (e.type === 'ai-title' && e.aiTitle) s.title = e.aiTitle;
    if (e.type === 'summary' && e.summary) s.summaryLine = e.summary;

    if (e.type !== 'user' && e.type !== 'assistant') continue;
    const t = Date.parse(e.timestamp);
    if (!Number.isNaN(t)) timestamps.push(t);

    if (e.type === 'user') {
      if (isRealPrompt(e)) {
        s.userMessages++;
        s.prompts.push(textOf(e.message.content).trim());
      }
      // git commit / push の結果から、実際に成功したものだけを拾う
      for (const c of Array.isArray(e.message?.content) ? e.message.content : []) {
        const kind = c?.type === 'tool_result' && gitToolUses.get(c.tool_use_id);
        if (!kind) continue;
        if (kind.push && !c.is_error) s.pushes++;
        if (kind.commit) {
          const found = parseCommitOutput(toolResultText(c));
          for (const cm of found) {
            if (!s.commits.has(cm.hash)) s.commits.set(cm.hash, { ...cm, at: e.timestamp || null });
          }
          if (!found.length && !c.is_error && e.timestamp) s.quietCommits.push(e.timestamp);
        }
      }
      continue;
    }

    // assistant: 1レスポンスが複数行に分割されるので message.id で重複を除く
    const msg = e.message || {};
    const mid = msg.id || e.requestId || e.uuid;
    if (!seenMessageIds.has(mid)) {
      seenMessageIds.add(mid);
      if (!e.isSidechain) s.assistantMessages++;
      if (msg.model && !msg.model.startsWith('<')) s.models.add(msg.model);
    }
    // 分割された行のうち、後ろの行ほど output_tokens が確定値に近いので最後の usage を採る
    if (msg.usage) {
      const prev = msgUsage.get(mid);
      msgUsage.set(mid, {
        timestamp: prev?.timestamp || e.timestamp,
        model: msg.model,
        u: msg.usage,
        final: Boolean(prev?.final || msg.stop_reason),
        chars: (prev?.chars || 0) + contentChars(msg.content),
      });
    }
    for (const c of Array.isArray(msg.content) ? msg.content : []) {
      if (c.type === 'text' && c.text && !e.isSidechain) s.assistantTexts.push(c.text);
      if (c.type !== 'tool_use') continue;
      s.toolCalls[c.name] = (s.toolCalls[c.name] || 0) + 1;
      const input = c.input || {};
      if (EDIT_TOOLS.has(c.name)) {
        const fp = input.file_path || input.notebook_path;
        if (fp) s.changedFiles.add(fp);
      }
      if (c.name === 'Bash' && typeof input.command === 'string') {
        s.commands.push(input.command);
        const kind = gitCommandKind(input.command);
        if (kind.commit) s.commitAttempts++;
        if (kind.commit || kind.push) gitToolUses.set(c.id, kind);
      }
    }
  }

  let estimatedOutput = 0;
  for (const { timestamp, model, u: logged, final, chars } of msgUsage.values()) {
    let u = logged;
    // stop_reason の無い応答(サブエージェントのログなど)は、ストリーム開始時点の usage しか残っておらず
    // output_tokens が極端に小さい。出力した本文の長さから見積もった値の方が大きければそちらを使う
    if (!final) {
      const est = Math.ceil(chars / CHARS_PER_OUTPUT_TOKEN);
      if (est > (u.output_tokens || 0)) {
        estimatedOutput += est - (u.output_tokens || 0);
        u = { ...u, output_tokens: est };
      }
    }
    s.tokens.input += u.input_tokens || 0;
    s.tokens.output += u.output_tokens || 0;
    s.tokens.cacheRead += u.cache_read_input_tokens || 0;
    s.tokens.cacheCreation += u.cache_creation_input_tokens || 0;
    addUsage(s.usage, timestamp, model, u);
  }

  timestamps.sort((a, b) => a - b);
  const segments = buildSegments(timestamps);
  const cwd = s.cwd;
  const changedFiles = [...s.changedFiles].map((f) => (cwd && f.startsWith(cwd + '/') ? f.slice(cwd.length + 1) : f));

  return {
    id: s.id,
    file: s.file,
    projectDir: s.projectDir,
    project: projectNameFrom(cwd, projectDir),
    cwd,
    gitBranch: s.gitBranch,
    title: s.title || s.summaryLine || firstLine(s.prompts[0]) || '(無題のセッション)',
    firstPrompt: s.prompts[0] ? s.prompts[0].slice(0, 2000) : null,
    prompts: s.prompts.map((p) => p.slice(0, 1000)),
    lastAssistantText: s.assistantTexts.length ? s.assistantTexts[s.assistantTexts.length - 1].slice(0, 2000) : null,
    assistantTexts: s.assistantTexts.map((t) => t.slice(0, 600)),
    start: timestamps.length ? new Date(timestamps[0]).toISOString() : null,
    end: timestamps.length ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
    segments,
    activeMs: segments.reduce((sum, g) => sum + (Date.parse(g.end) - Date.parse(g.start)), 0),
    userMessages: s.userMessages,
    assistantMessages: s.assistantMessages,
    messageCount: s.userMessages + s.assistantMessages,
    toolCalls: s.toolCalls,
    changedFiles,
    commands: s.commands.slice(-50).map((c) => c.slice(0, 300)),
    // 出力でハッシュを確認できたコミット + 成功したがハッシュが出なかったコミット
    commits: s.commits.size + s.quietCommits.length,
    commitList: [...s.commits.values()],
    quietCommits: s.quietCommits,
    commitAttempts: s.commitAttempts,
    pushes: s.pushes,
    models: [...s.models],
    tokens: s.tokens,
    usage: Object.fromEntries(s.usage),
    estimatedOutputTokens: estimatedOutput, // 見積もりで補った出力トークン数
  };
}

// 確定した usage を持つ応答の実測で、本文(テキスト + ツール入力のJSON)はおよそ2文字で1トークン。
// 思考(thinking)の本文はログに残らないので、見積もりは実際より少なめになる
const CHARS_PER_OUTPUT_TOKEN = 2;

function contentChars(content) {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const c of content) {
    if (c?.type === 'text') n += (c.text || '').length;
    else if (c?.type === 'tool_use') n += JSON.stringify(c.input || {}).length;
  }
  return n;
}

// コスト計算用に、利用量を1時間・モデル単位でまとめる(時刻はUTC。日付への振り分けは表示側で行う)
function addUsage(map, timestamp, model, u) {
  if (!timestamp || !model || model.startsWith('<')) return; // <synthetic> などAPIを呼んでいない応答
  const cw = u.cache_creation || {};
  const total = u.cache_creation_input_tokens || 0;
  const cw1h = cw.ephemeral_1h_input_tokens || 0;
  // 内訳が無い古いログは、Claude Code の既定である5分キャッシュとみなす
  const cw5m = cw.ephemeral_5m_input_tokens ?? Math.max(0, total - cw1h);
  const key = [timestamp.slice(0, 13), model, u.speed === 'fast' ? 'fast' : '', u.inference_geo === 'us' ? 'us' : ''].join('|');
  const row = map.get(key) || [0, 0, 0, 0, 0, 0];
  row[0] += u.input_tokens || 0;
  row[1] += u.output_tokens || 0;
  row[2] += u.cache_read_input_tokens || 0;
  row[3] += cw5m;
  row[4] += cw1h;
  row[5] += u.server_tool_use?.web_search_requests || 0;
  map.set(key, row);
}

function firstLine(text) {
  if (!text) return null;
  const line = text.split('\n').find((l) => l.trim()) || '';
  // 見出しや引用の記号(行頭の # や >)と、強調・コードの記号だけを落とす。"acme/api#12" の # は残す
  const clean = line.replace(/^\s*(?:#{1,6}\s+|>\s*)/, '').replace(/[*`]/g, '').trim();
  return clipMasked(clean, 60);
}

export async function parseSessionFile(file, projectDir) {
  const text = await readFile(file, 'utf8');
  return parseSessionText(text, { file, projectDir });
}
