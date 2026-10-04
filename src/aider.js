// Aider のチャット履歴を、Claude Code と同じ形の集計レコードに変換する。
// 形式は Aider-AI/aider の aider/io.py・coders/base_coder.py・repo.py と prompt_toolkit の FileHistory に合わせている:
//   .aider.chat.history.md(リポジトリの直下。起動ごとに追記)
//     "# aider chat started at YYYY-MM-DD HH:MM:SS"(ローカル時刻)で1回の起動が始まる
//     依頼は行頭 "#### "(複数行の依頼は "  \n#### " でつながる)、ツールの出力は行頭 "> "、それ以外は AI の応答
//     "> Model: <モデル> with <形式> edit format" / "> Main model: …"、"> Tokens: 2.3k sent, 1.2k cache write, 5k cache hit, 156 received."、
//     "> Applied edit to <ファイル>"、"> Commit <ハッシュ> <メッセージ>"
//   .aider.input.history(同じ場所)は入力ごとに "\n# 2024-05-01 10:20:30.123456\n+<行>…"(ローカル時刻)
//     依頼ごとの時刻はこちらからしか取れないので、あれば使う
// 中央の保存場所は無いので、WORKLOG_AIDER_DIRS(パス区切りのリスト)のフォルダの下を3階層まで探す
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { SEGMENT_GAP_MS } from './parser.js';
import { addTime, addUsage, createCollector, finish } from './record.js';

export const HISTORY_FILE = '.aider.chat.history.md';
export const INPUT_HISTORY_FILE = '.aider.input.history';
const START_RE = /^# aider chat started at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.cache']);
// 依頼の中身を持つチャットモードのコマンド。それ以外の "/add" などは依頼として数えない
const CHAT_COMMANDS = /^\/(ask|code|architect|context|help)\s+/;

// "YYYY-MM-DD HH:MM:SS(.ffffff)" をローカル時刻として読む
export function localTime(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/);
  if (!m) return NaN;
  return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? Math.floor(+m[7].padEnd(6, '0') / 1000) : 0).getTime();
}

// "2.3k" / "156" / "12k"
function tokenCount(s) {
  const m = String(s).match(/^([\d.,]+)(k?)$/);
  if (!m) return 0;
  return Math.round(parseFloat(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1));
}

// 履歴ファイルを起動ごとに分ける: [{ start(ms), startText, text }]
export function splitSessions(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const m = line.match(START_RE);
    if (m) {
      cur = { startText: m[1], start: localTime(m[1]), lines: [] };
      out.push(cur);
    } else if (cur) cur.lines.push(line);
  }
  return out.map((s) => ({ start: s.start, startText: s.startText, text: s.lines.join('\n') }));
}

// .aider.input.history の入力: [{ at(ms), text }]
export function parseInputHistory(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^# (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*$/);
    if (m) {
      cur = { at: localTime(m[1]), lines: [] };
      out.push(cur);
    } else if (cur && line.startsWith('+')) cur.lines.push(line.slice(1));
  }
  return out.filter((e) => Number.isFinite(e.at)).map((e) => ({ at: e.at, text: e.lines.join('\n') }));
}

export function sessionId(file, startText) {
  return 'aider-' + createHash('sha256').update(`${file}\n${startText}`).digest('hex').slice(0, 24);
}

// 1回の起動分(splitSessions の要素)をセッションにする。inputs: その間の入力履歴、endHint: 最後の起動ならファイルの更新時刻
export function parseAiderSession(section, { file = '', cwd = null, inputs = [], endHint = null } = {}) {
  const c = createCollector();
  addTime(c, section.start);
  let model = null;
  let prompt = null; // 組み立て中の依頼(複数行)
  let reply = [];
  let lastAt = section.start;
  const flushReply = () => {
    const body = reply.join('\n').trim();
    if (body) {
      c.assistantMessages++;
      c.assistantTexts.push(body);
    }
    reply = [];
  };
  let next = 0; // 次に照合する入力履歴の位置
  const flushPrompt = () => {
    if (prompt === null) return;
    const raw = prompt.join('\n').trim();
    prompt = null;
    // 入力履歴の同じ入力と照合して、この依頼の時刻を得る(続く利用量・コミットの時刻に使う)
    for (let k = next; k < Math.min(inputs.length, next + 5); k++) {
      if (inputs[k].text.trim() !== raw) continue;
      lastAt = inputs[k].at;
      next = k + 1;
      break;
    }
    // /run や /git で打ったコマンドも数える
    const cmd = raw.match(/^\/(run|git)\s+([\s\S]+)$/);
    if (cmd) c.commands.push(cmd[1] === 'git' ? `git ${cmd[2]}` : cmd[2]);
    let body = raw;
    if (CHAT_COMMANDS.test(body)) body = body.replace(CHAT_COMMANDS, '');
    else if (body.startsWith('/') || body === '<blank>') return;
    if (body) c.prompts.push(body);
  };

  for (const raw of section.text.split('\n')) {
    const line = raw.replace(/ {2}$/, '');
    if (raw.startsWith('#### ')) {
      if (prompt === null) flushReply();
      (prompt ||= []).push(line.slice(5));
      continue;
    }
    flushPrompt();
    // ツールの出力は '> ' で始まる行(SEARCH/REPLACE ブロックの '>>>>>>> REPLACE' は応答の一部)
    if (!/^>( |$)/.test(raw)) {
      reply.push(raw);
      continue;
    }
    flushReply();
    const out = line.replace(/^>\s?/, '');
    let m;
    if ((m = out.match(/^(?:Main model|Model): (\S+) with /))) {
      model = m[1];
      c.models.add(model);
    } else if ((m = out.match(/^Tokens: ([\d.,]+k?) sent(?:, ([\d.,]+k?) cache write)?(?:, ([\d.,]+k?) cache hit)?, ([\d.,]+k?) received\./))) {
      const sent = tokenCount(m[1]);
      const write = tokenCount(m[2] || '0');
      const hit = tokenCount(m[3] || '0');
      // "sent" はキャッシュ分を含む値として差し引く(表示は "2.3k" のように丸められているので概算)
      addUsage(c, lastAt, model, { input: sent - write - hit, output: tokenCount(m[4]), cacheRead: hit, cacheWrite: write });
    } else if ((m = out.match(/^Applied edit to (.+)$/))) {
      c.changedFiles.add(m[1].trim());
    } else if ((m = out.match(/^Commit ([0-9a-f]{7,40}) (.*)$/))) {
      if (!c.commits.has(m[1])) c.commits.set(m[1], { hash: m[1], branch: null, subject: m[2].trim(), at: new Date(lastAt).toISOString() });
    }
  }
  flushPrompt();
  flushReply();

  // 依頼ごとの時刻は入力履歴から取る
  for (const i of inputs) addTime(c, i.at);
  // 最後の起動は、ファイルの更新時刻を終わりとみなす(最後の入力から間が空いていなければ)
  const last = Math.max(...c.timestamps);
  if (endHint && endHint > last && endHint - last <= SEGMENT_GAP_MS) addTime(c, endHint);

  return finish(c, { tool: 'aider', id: sessionId(file, section.startText), file: `${file}#${section.startText}`, cwd });
}

// 入力履歴のうち [start, next) に入るもの
function inputsBetween(inputs, start, next) {
  return inputs.filter((i) => i.at >= start && (next === undefined || i.at < next));
}

async function readSafe(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

// 履歴ファイルをセッションに分けた結果を、ファイルの更新時刻・サイズで覚えておく(定期スキャンのたびに読み直さない)
const splitCache = new Map(); // file -> { key, sections }

async function sectionsOf(file) {
  const st = await stat(file);
  const inputFile = path.join(path.dirname(file), INPUT_HISTORY_FILE);
  const ist = await stat(inputFile).catch(() => null);
  const key = `${st.mtimeMs}|${st.size}|${ist?.mtimeMs}|${ist?.size}`;
  const hit = splitCache.get(file);
  if (hit?.key === key) return hit;
  const sections = splitSessions(await readFile(file, 'utf8'));
  const inputs = parseInputHistory(await readSafe(inputFile));
  const v = { key, sections, inputs, mtimeMs: st.mtimeMs };
  splitCache.set(file, v);
  return v;
}

// dir の下を3階層まで探して .aider.chat.history.md を集める
async function findHistories(root, maxDepth = 3) {
  const out = [];
  const walk = async (d, depth) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && e.name === HISTORY_FILE) out.push(path.join(d, e.name));
      else if (e.isDirectory() && depth < maxDepth && !SKIP_DIRS.has(e.name)) await walk(path.join(d, e.name), depth + 1);
    }
  };
  await walk(root, 0);
  return out;
}

// dirs: WORKLOG_AIDER_DIRS(path.delimiter 区切り)。1回の起動ごとに1件を返す。
// file は "<履歴ファイル>#<開始時刻>"(仮想のキー)、mtimeMs / size はその起動分の内容から決める
export async function listAider(dirs) {
  const roots = String(dirs || '').split(path.delimiter).map((d) => d.trim()).filter(Boolean);
  const files = new Set();
  for (const r of roots) for (const f of await findHistories(path.resolve(r))) files.add(f);
  const out = [];
  for (const file of files) {
    let v;
    try {
      v = await sectionsOf(file);
    } catch {
      continue;
    }
    v.sections.forEach((s, i) => {
      const next = v.sections[i + 1]?.start;
      const isLast = i === v.sections.length - 1;
      const inputs = inputsBetween(v.inputs, s.start, next);
      out.push({
        file: `${file}#${s.startText}`,
        historyFile: file,
        // 前の起動の内容は変わらない。最後の起動だけファイルの更新時刻で変化を見る
        mtimeMs: isLast ? v.mtimeMs : s.start,
        size: s.text.length + inputs.length,
      });
    });
  }
  return out;
}

export async function parseAiderFile(file, entry = {}) {
  const historyFile = entry.historyFile || file.replace(/#[^/\\]*$/, '');
  const startText = file.slice(historyFile.length + 1);
  const v = await sectionsOf(historyFile);
  const i = v.sections.findIndex((s) => s.startText === startText);
  if (i < 0) throw new Error(`起動 ${startText} が見つかりません`);
  const s = v.sections[i];
  const next = v.sections[i + 1]?.start;
  return parseAiderSession(s, {
    file: historyFile,
    cwd: path.dirname(historyFile),
    inputs: inputsBetween(v.inputs, s.start, next),
    endHint: i === v.sections.length - 1 ? v.mtimeMs : null,
  });
}
