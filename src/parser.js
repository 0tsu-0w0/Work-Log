// Claude Code のセッションログ(JSONL)を1セッション分の集計レコードに変換する。
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
  };
  const timestamps = [];
  const seenMessageIds = new Set();
  const gitToolUses = new Map(); // tool_use id -> { commit, push }

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
      const u = msg.usage;
      if (u) {
        s.tokens.input += u.input_tokens || 0;
        s.tokens.output += u.output_tokens || 0;
        s.tokens.cacheRead += u.cache_read_input_tokens || 0;
        s.tokens.cacheCreation += u.cache_creation_input_tokens || 0;
      }
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
  };
}

function firstLine(text) {
  if (!text) return null;
  const line = text.split('\n').find((l) => l.trim()) || '';
  const clean = line.replace(/[*#`>]/g, '').trim();
  return clean.length > 60 ? clean.slice(0, 60) + '…' : clean;
}

export async function parseSessionFile(file, projectDir) {
  const text = await readFile(file, 'utf8');
  return parseSessionText(text, { file, projectDir });
}
