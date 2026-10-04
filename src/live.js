// hooks から届いたイベント(events.jsonl)を取り込み、セッションごとの最新状態を持つ。
// 読んだ位置を覚えておき、追記された分だけを読む。
import { open, readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { EVENTS_FILE } from './hook.js';

const STATE_VERSION = 1;
// イベントファイルがこれを超えたら、取り込み済みの分を捨てて作り直す
const ROTATE_BYTES = 5 * 1024 * 1024;
// フックが無いときの「作業中」判定: 最終書き込みからこの時間以内
export const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
// 終了イベントが来ないまま(端末を閉じた、クラッシュなど)この時間が経てば完了扱い
export const STALE_MS = 30 * 60 * 1000;

export function applyEvent(sessions, ev) {
  if (!ev?.sessionId || !ev.event) return;
  const s = (sessions[ev.sessionId] ||= { turns: 0 });
  if (ev.cwd) s.cwd = ev.cwd;
  if (ev.transcriptPath) s.transcriptPath = ev.transcriptPath;
  switch (ev.event) {
    case 'SessionStart':
      if (!s.startedAt) s.startedAt = ev.ts;
      s.source = ev.source || s.source;
      // 自動コンパクトはターンの途中でも起きるので、作業中/入力待ちの状態は変えない
      if (ev.source === 'compact' && s.lastEvent) return void (s.lastEventAt = ev.ts);
      delete s.endedAt;
      delete s.endReason;
      break;
    case 'UserPromptSubmit':
      s.turns++;
      break;
    case 'SessionEnd':
      s.endedAt = ev.ts;
      s.endReason = ev.reason || null;
      break;
  }
  s.lastEvent = ev.event;
  s.lastEventAt = ev.ts;
}

// working: Claudeが作業中 / waiting: 応答を終えて入力待ち / done: 終了
export function deriveStatus(hook, sessionEnd, now = Date.now()) {
  const lastLog = Date.parse(sessionEnd) || 0;
  if (!hook) return now - lastLog < ACTIVE_WINDOW_MS ? 'working' : 'done';
  const last = Math.max(lastLog, Date.parse(hook.lastEventAt) || 0);
  if (hook.lastEvent === 'SessionEnd' || now - last > STALE_MS) return 'done';
  return hook.lastEvent === 'UserPromptSubmit' ? 'working' : 'waiting';
}

export class HookLog {
  constructor(cacheDir) {
    this.eventsFile = path.join(cacheDir, EVENTS_FILE);
    this.stateFile = path.join(cacheDir, 'hooks-state.json');
    this.offset = 0;
    this.sessions = {};
    this.lastEventAt = null;
    this.loaded = false;
    this.ingesting = null;
  }

  async load() {
    try {
      const st = JSON.parse(await readFile(this.stateFile, 'utf8'));
      if (st.version === STATE_VERSION) Object.assign(this, { offset: st.offset, sessions: st.sessions, lastEventAt: st.lastEventAt });
    } catch {
      // 初回
    }
    this.loaded = true;
  }

  get(sessionId) {
    return this.sessions[sessionId] || null;
  }

  ingest() {
    if (!this.ingesting) this.ingesting = this._ingest().finally(() => (this.ingesting = null));
    return this.ingesting;
  }

  async _ingest() {
    if (!this.loaded) await this.load();
    let size;
    try {
      size = (await stat(this.eventsFile)).size;
    } catch {
      return 0;
    }
    if (size < this.offset) this.offset = 0; // 外部で削除・作り直しされた
    let count = await this._readFrom(this.eventsFile);
    if (this.offset > ROTATE_BYTES) count += await this._rotate();
    if (count) await this._save();
    return count;
  }

  // ファイルの offset 以降を読む。書き込み途中の最終行は次回に回す
  async _readFrom(file) {
    const fh = await open(file, 'r');
    try {
      const { size } = await fh.stat();
      if (size <= this.offset) return 0;
      const buf = Buffer.alloc(size - this.offset);
      await fh.read(buf, 0, buf.length, this.offset);
      const end = buf.lastIndexOf(0x0a);
      if (end < 0) return 0;
      let count = 0;
      for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          applyEvent(this.sessions, ev);
          if (!this.lastEventAt || ev.ts > this.lastEventAt) this.lastEventAt = ev.ts;
          count++;
        } catch {
          // 壊れた行は読み飛ばす
        }
      }
      this.offset += end + 1;
      return count;
    } finally {
      await fh.close();
    }
  }

  // 改名後に追記された残りを読み切ってから捨てる。新しいフックは新しいファイルに書く
  async _rotate() {
    const old = `${this.eventsFile}.rotating`;
    await rename(this.eventsFile, old);
    const count = await this._readFrom(old);
    await rm(old, { force: true });
    this.offset = 0;
    return count;
  }

  async _save() {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: STATE_VERSION, offset: this.offset, sessions: this.sessions, lastEventAt: this.lastEventAt }));
    await rename(tmp, this.stateFile);
  }
}
