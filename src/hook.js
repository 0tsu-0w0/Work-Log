// Claude Code の hooks から呼ばれる受け口。
// stdin のJSONを ~/.work-log/events.jsonl に1行追記し、起動中のサーバーがあれば通知する。
// Claude Code の動作を妨げないよう、標準出力には何も書かず、失敗しても必ず exit 0 で終わる。
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

export const EVENTS_FILE = 'events.jsonl';
export const SERVER_FILE = 'server.json';
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'];
const POKE_TIMEOUT_MS = 300;

// 依頼文などの本文は記録しない(トランスクリプトに既にあり、ここで複製する必要がない)
export function toEventRecord(input, now = new Date()) {
  if (!input || typeof input.session_id !== 'string' || !HOOK_EVENTS.includes(input.hook_event_name)) return null;
  const rec = {
    ts: now.toISOString(),
    event: input.hook_event_name,
    sessionId: input.session_id,
    cwd: input.cwd,
    transcriptPath: input.transcript_path,
  };
  if (input.source) rec.source = input.source; // SessionStart: startup / resume / clear / compact
  if (input.reason) rec.reason = input.reason; // SessionEnd: clear / logout / prompt_input_exit / other など
  return rec;
}

export async function readStdin(stream = process.stdin) {
  let data = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) data += chunk;
  return data;
}

function poke(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/hook', method: 'POST', timeout: POKE_TIMEOUT_MS }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', resolve);
    req.end();
  });
}

export async function handleHook(raw, { cacheDir, now = new Date() }) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }
  const rec = toEventRecord(input, now);
  if (!rec) return null;
  await mkdir(cacheDir, { recursive: true });
  // 1行(数百バイト)の O_APPEND 書き込みなので、同時に複数のフックが走っても行は混ざらない
  await appendFile(path.join(cacheDir, EVENTS_FILE), JSON.stringify(rec) + '\n');
  try {
    const { port } = JSON.parse(await readFile(path.join(cacheDir, SERVER_FILE), 'utf8'));
    if (port) await poke(port);
  } catch {
    // サーバー未起動。次回起動時に events.jsonl から取り込まれる
  }
  return rec;
}
