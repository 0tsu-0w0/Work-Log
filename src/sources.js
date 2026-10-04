// Claude Code 以外のツールのログの取り込み元。取り込み元を足すときは、ここに1つ足す。
//   name: セッションの tool の値 / label: 表示名 / dir(env, home): ログの場所(既定)
//   list(dir): [{ file, ... }](解析するもの) / parse(file, entry): セッション(parser.js と同じ形)。entry は list の要素
//     file は変更検出とキャッシュのキー。既定ではそのファイルの mtime / size で変更を見る。
//     1ファイルに複数セッションがある・DB の中にある場合は、file を仮想のキー("<パス>#<ID>")にして
//     mtimeMs と size を entry に入れるか、statFile に実際のファイルを入れる。parentId を入れるとサブエージェント扱い
//   watch(dir): 変更を監視するフォルダ(任意)。dir が無い(null)取り込み元は読まない
import path from 'node:path';
import os from 'node:os';
import { readdir } from 'node:fs/promises';
import { parseCodexFile } from './codex.js';
import { listGemini, parseGeminiFile } from './gemini.js';
import { listCopilot, parseCopilotFile } from './copilot.js';
import { listAider, parseAiderFile } from './aider.js';
import { defaultCursorDir, listCursor, parseCursorFile } from './cursor.js';

// dir の下を depth 段までたどり、test に合うファイルを集める
export async function walkFiles(dir, test, maxDepth = 4) {
  const out = [];
  const walk = async (d, depth) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < maxDepth) await walk(p, depth + 1);
      else if (e.isFile() && test(e.name, p)) out.push(p);
    }
  };
  await walk(dir, 0);
  return out;
}

export const SOURCES = [
  {
    name: 'codex',
    label: 'Codex',
    // Codex CLI のログ。CODEX_HOME(既定 ~/.codex)の sessions / archived_sessions
    dir: (env, home) => env.WORKLOG_CODEX_DIR || env.CODEX_HOME || path.join(home, '.codex'),
    // <dir>/sessions/YYYY/MM/DD/rollout-*.jsonl(.zst) と archived_sessions/
    async list(dir) {
      const re = /^rollout-.*\.jsonl(\.zst)?$/;
      const files = [...(await walkFiles(path.join(dir, 'sessions'), (n) => re.test(n))), ...(await walkFiles(path.join(dir, 'archived_sessions'), (n) => re.test(n)))];
      // 圧縮済みと未圧縮が両方あるときは未圧縮(書き込み中の可能性がある方)を使う
      const plain = new Set(files.filter((f) => !f.endsWith('.zst')));
      return files.filter((f) => !(f.endsWith('.zst') && plain.has(f.slice(0, -4)))).map((file) => ({ file }));
    },
    parse: parseCodexFile,
    watch: (dir) => [path.join(dir, 'sessions')],
  },
  {
    name: 'gemini',
    label: 'Gemini CLI',
    // Gemini CLI は GEMINI_CLI_HOME(既定はホーム)の .gemini に保存する
    dir: (env, home) => env.WORKLOG_GEMINI_DIR || path.join(env.GEMINI_CLI_HOME || home, '.gemini'),
    list: listGemini, // <dir>/tmp/<プロジェクトID>/chats/session-*.jsonl(.json)
    parse: parseGeminiFile,
    watch: (dir) => [path.join(dir, 'tmp')],
  },
  {
    name: 'copilot',
    label: 'Copilot CLI',
    // GitHub Copilot CLI は COPILOT_HOME(既定 ~/.copilot)に保存する
    dir: (env, home) => env.WORKLOG_COPILOT_DIR || env.COPILOT_HOME || path.join(home, '.copilot'),
    list: listCopilot, // <dir>/session-state/<ID>/events.jsonl と旧形式の history-session-state/*.json
    parse: parseCopilotFile,
    watch: (dir) => [path.join(dir, 'session-state')],
  },
  {
    name: 'aider',
    label: 'Aider',
    // Aider は各リポジトリに履歴を書くので、探すフォルダを WORKLOG_AIDER_DIRS(パス区切り)で指定したときだけ読む
    dir: (env) => env.WORKLOG_AIDER_DIRS || null,
    list: listAider,
    parse: parseAiderFile,
  },
  {
    name: 'cursor',
    label: 'Cursor',
    // Cursor のユーザーデータ(…/Cursor/User)。形式は非公式(cursor.js を参照)。DB は常に書き換わるので監視せず定期スキャンで読む
    dir: (env, home) => env.WORKLOG_CURSOR_DIR || defaultCursorDir(env, home),
    list: listCursor,
    parse: parseCursorFile,
  },
];

export const SOURCE_BY_NAME = Object.fromEntries(SOURCES.map((s) => [s.name, s]));

// 表示名(Claude Code を含む)
export const TOOL_LABELS = { claude: 'Claude Code', ...Object.fromEntries(SOURCES.map((s) => [s.name, s.label])) };
export const toolLabel = (t) => TOOL_LABELS[t] || t;

// 各取り込み元の既定の場所(環境変数で変えられる)
export function defaultSourceDirs(env = process.env, home = os.homedir()) {
  return Object.fromEntries(SOURCES.map((s) => [s.name, s.dir(env, home)]));
}
