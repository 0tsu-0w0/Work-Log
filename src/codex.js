// OpenAI Codex CLI のセッションログ(rollout)を、Claude Code と同じ形の集計レコードに変換する。
// 形式は openai/codex の codex-rs(rollout / protocol)に合わせている:
//   各行 {"timestamp", "type": session_meta | response_item | event_msg | turn_context | token_usage_record | compacted …, "payload"}
//   保存先 $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<時刻>-<id>.jsonl(7日以上前のものは .jsonl.zst に圧縮される)
import { clipMasked } from './mask.js';
import { readFile } from 'node:fs/promises';
import zlib from 'node:zlib';
import path from 'node:path';
import { buildSegments, gitCommandKind, parseCommitOutput, projectNameFrom } from './parser.js';

const SHELL_TOOLS = new Set(['shell', 'container.exec', 'exec_command', 'shell_command', 'local_shell']);
// Codex が依頼の前に差し込む文脈は依頼として数えない
const INJECTED_PREFIXES = ['<environment_context>', '<user_instructions>', '<permissions', '<turn_aborted>', '# AGENTS.md', '<user_shell_command>'];

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && typeof c.text === 'string').map((c) => c.text).join('\n');
}

// shell 系ツールの引数からコマンド文字列を取り出す。["bash","-lc","…"] は中身を使う
export function commandFromArgs(args) {
  let a = args;
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a);
    } catch {
      return a;
    }
  }
  const cmd = a?.command ?? a?.cmd;
  if (typeof cmd === 'string') return cmd;
  if (Array.isArray(cmd)) {
    const i = cmd.findIndex((x) => x === '-lc' || x === '-c');
    return i >= 0 && cmd[i + 1] ? cmd[i + 1] : cmd.join(' ');
  }
  return '';
}

// apply_patch の本文から変更したファイルを取り出す
export function filesFromPatch(patch) {
  const out = [];
  for (const m of String(patch || '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) out.push((m[1] || m[2]).trim());
  return out;
}

function outputText(output) {
  if (typeof output === 'string') {
    try {
      const j = JSON.parse(output); // 旧形式: {"output": "...", "metadata": {"exit_code": 0}}
      if (j && typeof j.output === 'string') return { text: j.output, exitCode: j.metadata?.exit_code };
    } catch {
      // 素の文字列
    }
    // 0.1xx の exec_command: "Chunk ID: …\nWall time: …\nProcess exited with code 1\n…\nOutput:\n…"
    const m = output.match(/^Process exited with code (-?\d+)$/m);
    return { text: output, exitCode: m ? Number(m[1]) : undefined };
  }
  return { text: textOfContent(output) };
}

function readCodexUsage(u) {
  if (!u) return null;
  const cached = u.cached_input_tokens || 0;
  // input_tokens はキャッシュ分を含むので差し引く。output_tokens は推論トークンを含む
  return {
    input_tokens: Math.max(0, (u.input_tokens || 0) - cached),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: u.cache_write_input_tokens || 0,
    output_tokens: u.output_tokens || 0,
  };
}

export function parseCodexText(text, { file = '' } = {}) {
  const s = {
    id: path.basename(file).replace(/\.jsonl(\.zst)?$/, '').replace(/^rollout-[\dT:-]+-/, ''),
    cwd: null,
    gitBranch: null,
    repoUrl: null,
    model: null,
    prompts: [],
    responseUserPrompts: [],
    assistantTexts: [],
    assistantMessages: 0,
    toolCalls: {},
    changedFiles: new Set(),
    commands: [],
    commitAttempts: 0,
    commits: new Map(),
    quietCommits: [],
    pushes: 0,
    models: new Set(),
    usageRecords: [],
    tokenCounts: [],
  };
  const timestamps = [];
  const calls = new Map(); // call_id -> { commit, push }
  const done = new Set(); // 結果を処理済みの call_id(function_call_output と exec_command_end の二重処理を防ぐ)

  const onResult = (callId, text, failed, ts) => {
    const kind = calls.get(callId);
    if (!kind || done.has(callId)) return;
    done.add(callId);
    if (kind.push && !failed) s.pushes++;
    if (kind.commit) {
      const found = parseCommitOutput(text || '');
      for (const cm of found) if (!s.commits.has(cm.hash)) s.commits.set(cm.hash, { ...cm, at: ts || null });
      if (!found.length && !failed && ts) s.quietCommits.push(ts);
    }
  };

  const onShell = (callId, command) => {
    if (!command) return;
    s.commands.push(command);
    const kind = gitCommandKind(command);
    if (kind.commit) s.commitAttempts++;
    if (callId && (kind.commit || kind.push)) calls.set(callId, kind);
  };

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    let { type, payload, timestamp: ts } = e;
    // 旧形式: 1行目がメタ情報そのもの、以降は ResponseItem がそのまま並ぶ
    if (!payload) {
      if (e.id && e.timestamp && !type) [type, payload] = ['session_meta', e];
      else if (type && type !== 'state' && !e.record_type) [type, payload] = ['response_item', e];
      else continue;
    }
    const t = Date.parse(ts);

    if (type === 'session_meta') {
      if (payload.id) s.id = String(payload.id);
      if (payload.cwd) s.cwd = String(payload.cwd);
      if (payload.git?.branch) s.gitBranch = payload.git.branch;
      if (payload.git?.repository_url) s.repoUrl = payload.git.repository_url;
      if (!Number.isNaN(Date.parse(payload.timestamp))) timestamps.push(Date.parse(payload.timestamp));
      continue;
    }
    if (type === 'turn_context') {
      if (payload.model) {
        s.model = payload.model;
        s.models.add(payload.model);
      }
      if (payload.cwd && !s.cwd) s.cwd = String(payload.cwd);
      continue;
    }
    if (type === 'token_usage_record') {
      if (payload.usage) s.usageRecords.push({ ts, model: s.model, usage: payload.usage });
      continue;
    }
    if (type === 'event_msg') {
      const p = payload;
      if (p.type === 'user_message' && typeof p.message === 'string' && p.message.trim()) {
        s.prompts.push(p.message.trim());
        if (!Number.isNaN(t)) timestamps.push(t);
      } else if (p.type === 'agent_message' && typeof p.message === 'string') {
        if (!Number.isNaN(t)) timestamps.push(t);
      } else if (p.type === 'token_count' && p.info) {
        s.tokenCounts.push({ ts, model: s.model, info: p.info });
      } else if (p.type === 'item_completed' && p.item?.type === 'CommandExecution' && typeof p.item.exit_code === 'number') {
        // 0.1xx: コマンドの結果は item_completed(CommandExecution)にも入る(id は call_id と同じ)
        onResult(p.item.id, p.item.aggregated_output ?? [p.item.stdout, p.item.stderr].filter(Boolean).join('\n'), p.item.exit_code !== 0, ts);
      } else if (p.type === 'exec_command_end') {
        onResult(p.call_id, p.aggregated_output || [p.stdout, p.stderr].filter(Boolean).join('\n'), p.exit_code !== 0, ts);
      }
      continue;
    }
    if (type !== 'response_item') continue;
    if (!Number.isNaN(t)) timestamps.push(t);
    const p = payload;
    switch (p.type) {
      case 'message': {
        const body = textOfContent(p.content).trim();
        if (p.role === 'assistant') {
          s.assistantMessages++;
          if (body) s.assistantTexts.push(body);
        } else if (p.role === 'user' && body && !INJECTED_PREFIXES.some((x) => body.startsWith(x))) {
          s.responseUserPrompts.push(body);
        }
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        const name = p.name || p.type;
        s.toolCalls[name] = (s.toolCalls[name] || 0) + 1;
        if (name === 'apply_patch') {
          let patch = p.input ?? p.arguments;
          try {
            patch = JSON.parse(patch).input ?? patch;
          } catch {
            // custom_tool_call はパッチ本文がそのまま入る
          }
          for (const f of filesFromPatch(patch)) s.changedFiles.add(f);
        } else if (SHELL_TOOLS.has(name)) {
          onShell(p.call_id, commandFromArgs(p.arguments ?? p.input));
        }
        break;
      }
      case 'local_shell_call': {
        s.toolCalls.local_shell = (s.toolCalls.local_shell || 0) + 1;
        onShell(p.call_id, commandFromArgs(p.action));
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output': {
        const { text: out, exitCode } = outputText(p.output);
        onResult(p.call_id, out, exitCode !== undefined ? exitCode !== 0 : /^Exit code: [1-9]/m.test(out), ts);
        break;
      }
    }
  }

  // 依頼は event_msg の user_message を正とし、無い(古い)ログは response_item から拾う
  const prompts = s.prompts.length ? s.prompts : s.responseUserPrompts;
  const usage = codexUsage(s);
  timestamps.sort((a, b) => a - b);
  const segments = buildSegments(timestamps);
  const cwd = s.cwd;
  const changedFiles = [...s.changedFiles].map((f) => (cwd && f.startsWith(cwd + '/') ? f.slice(cwd.length + 1) : f));
  const firstLine = (prompts[0] || '').split('\n').find((l) => l.trim()) || '';

  return {
    tool: 'codex',
    id: s.id,
    file,
    projectDir: cwd ? path.basename(cwd) : '',
    project: projectNameFrom(cwd, ''),
    cwd,
    gitBranch: s.gitBranch,
    repoUrl: s.repoUrl || null,
    title: firstLine ? clipMasked(firstLine, 60) : '(無題のセッション)',
    firstPrompt: prompts[0] ? prompts[0].slice(0, 2000) : null,
    prompts: prompts.map((p) => p.slice(0, 1000)),
    lastAssistantText: s.assistantTexts.length ? s.assistantTexts[s.assistantTexts.length - 1].slice(0, 2000) : null,
    assistantTexts: s.assistantTexts.map((x) => x.slice(0, 600)),
    start: timestamps.length ? new Date(timestamps[0]).toISOString() : null,
    end: timestamps.length ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
    segments,
    activeMs: segments.reduce((sum, g) => sum + (Date.parse(g.end) - Date.parse(g.start)), 0),
    userMessages: prompts.length,
    assistantMessages: s.assistantMessages,
    messageCount: prompts.length + s.assistantMessages,
    toolCalls: s.toolCalls,
    changedFiles,
    commands: s.commands.slice(-50).map((c) => c.slice(0, 300)),
    commits: s.commits.size + s.quietCommits.length,
    commitList: [...s.commits.values()],
    quietCommits: s.quietCommits,
    commitAttempts: s.commitAttempts,
    pushes: s.pushes,
    models: [...s.models],
    tokens: usage.tokens,
    usage: usage.buckets,
    estimatedOutputTokens: 0,
  };
}

// 利用量: 応答ごとの token_usage_record(新しい形式)があればそれを使い、
// 無ければ token_count イベントの last_token_usage を、累計が増えたときだけ数える(同じ値が繰り返し届くため)
function codexUsage(s) {
  const records = [];
  if (s.usageRecords.length) {
    for (const r of s.usageRecords) records.push({ ts: r.ts, model: r.model, u: readCodexUsage(r.usage) });
  } else {
    let lastTotal = -1;
    for (const c of s.tokenCounts) {
      const total = c.info.total_token_usage?.total_tokens ?? -1;
      if (total <= lastTotal || !c.info.last_token_usage) continue;
      lastTotal = total;
      records.push({ ts: c.ts, model: c.model, u: readCodexUsage(c.info.last_token_usage) });
    }
  }
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const buckets = {};
  for (const { ts, model, u } of records) {
    tokens.input += u.input_tokens;
    tokens.output += u.output_tokens;
    tokens.cacheRead += u.cache_read_input_tokens;
    tokens.cacheCreation += u.cache_creation_input_tokens;
    if (!ts || !model) continue;
    const key = `${ts.slice(0, 13)}|${model}||`;
    const row = buckets[key] || [0, 0, 0, 0, 0, 0];
    row[0] += u.input_tokens;
    row[1] += u.output_tokens;
    row[2] += u.cache_read_input_tokens;
    row[3] += u.cache_creation_input_tokens;
    buckets[key] = row;
  }
  return { tokens, buckets };
}

export async function readCodexFile(file) {
  const buf = await readFile(file);
  if (!file.endsWith('.zst')) return buf.toString('utf8');
  if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('圧縮されたログ(.zst)の読み込みには Node.js 22.15 以降が必要です');
  return zlib.zstdDecompressSync(buf).toString('utf8');
}

export async function parseCodexFile(file) {
  return parseCodexText(await readCodexFile(file), { file });
}
