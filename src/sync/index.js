// 作業のセッションをカレンダー・工数管理サービスに記録する。記録先を足すときは、SYNCS に1行足す。
//   name: config.json のキー・API の target・対応表のファイル名 / label: 画面の表示名 / flag: CLI のオプション / env: 主な環境変数
//   Client: status() / setConfig() / payload(entry) / create(entry) → ID / update(id, entry) / remove(id) を持つクラス(base.js)
//     create / update は { id, etag } を返してもよい(etag は対応表に残し、次の update / remove に { etag } で渡す。CalDAV 用)
// 流れ: plan() で「追加・更新・削除」の一覧と hash を作って見せ、apply() で同じ hash のときだけ送る。
// 送ったものは <cacheDir>/sync-<name>.json(予定のキー → 相手側の ID と内容の hash)に記録し、何度実行しても重複させない。
// 削除するのは、この対応表にある(= Work Log が作った)もので、手元の区間が無くなったものだけ。
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GoogleCalendar } from './gcal.js';
import { Toggl } from './toggl.js';
import { Clockify } from './clockify.js';
import { Harvest } from './harvest.js';
import { CalDav } from './caldav.js';
import { buildEntries, allKeys } from './entries.js';
import { validTimeZone } from '../report.js';

export const SYNCS = [
  { name: 'gcal', label: 'Google カレンダー', flag: '--gcal', env: 'GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET・GOOGLE_REFRESH_TOKEN・GOOGLE_CALENDAR_ID', Client: GoogleCalendar },
  { name: 'toggl', label: 'Toggl Track', flag: '--toggl', env: 'TOGGL_API_TOKEN', Client: Toggl },
  { name: 'clockify', label: 'Clockify', flag: '--clockify', env: 'CLOCKIFY_API_KEY', Client: Clockify },
  { name: 'harvest', label: 'Harvest', flag: '--harvest', env: 'HARVEST_ACCESS_TOKEN・HARVEST_ACCOUNT_ID', Client: Harvest },
  { name: 'caldav', label: 'CalDAV カレンダー', flag: '--caldav', env: 'CALDAV_URL・CALDAV_USERNAME・CALDAV_PASSWORD', Client: CalDav },
];

export const SYNC_BY_NAME = Object.fromEntries(SYNCS.map((s) => [s.name, s]));

const MAP_VERSION = 1;
// Claude Code は古いログを自動で消す(既定で30日)。消えたセッションの予定まで消さないよう、
// セッションごと見当たらないものは、終わってからこの日数以内のものだけ削除する
const KEEP_MISSING_AFTER_DAYS = 20;

const sha = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 16);

const localDate = (iso, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

function fmtWhen(item, timeZone) {
  const a = new Date(item.start);
  const b = new Date(item.end);
  const day = a.toLocaleDateString('ja-JP', { timeZone, month: 'numeric', day: 'numeric', weekday: 'short' });
  const t = (d) => d.toLocaleTimeString('ja-JP', { timeZone, hour: '2-digit', minute: '2-digit' });
  return `${day} ${t(a)}〜${t(b)}`;
}

export class Syncs {
  // clients: { toggl: client, ... }(省いた記録先は環境変数から作る)
  constructor({ cacheDir, env = process.env, fetchImpl = fetch, clients = {} } = {}) {
    this.cacheDir = cacheDir;
    this.clients = Object.fromEntries(SYNCS.map((s) => [s.name, clients[s.name] || new s.Client({ env, fetchImpl })]));
    this.locks = new Map();
  }

  // config.json 全体を受け取り、記録先ごとの部分(gcal / toggl / clockify / harvest / caldav)を渡す
  setConfig(json = {}) {
    for (const s of SYNCS) this.clients[s.name].setConfig(json?.[s.name] || {});
  }

  get(name) {
    if (!Object.hasOwn(SYNC_BY_NAME, String(name))) throw Object.assign(new Error(`不明な記録先です: ${String(name).slice(0, 40)}(${SYNCS.map((s) => s.name).join(' / ')})`), { status: 400 });
    return this.clients[name];
  }

  // /api/config 用(トークンなどは含めない)
  list() {
    return SYNCS.map((s) => ({ name: s.name, label: s.label, env: s.env, flag: s.flag, ...this.clients[s.name].status() }));
  }

  file(name) {
    return path.join(this.cacheDir, `sync-${name}.json`);
  }

  async readMap(name) {
    try {
      const j = JSON.parse(await readFile(this.file(name), 'utf8'));
      if (j?.version === MAP_VERSION && j.entries && typeof j.entries === 'object') return j.entries;
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[work-log] ${this.file(name)} を読めません: ${err.message}`);
    }
    return {};
  }

  async writeMap(name, entries) {
    const file = this.file(name);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: MAP_VERSION, entries }, null, 1));
    await rename(tmp, file);
  }

  // 送る内容の一覧。sessions は store.sessions() の形、from / to はミリ秒(区間の開始がこの範囲に入るものが対象)
  async plan(name, sessions, { from, to, now = Date.now() } = {}) {
    const client = this.get(name);
    const def = SYNC_BY_NAME[name];
    if (!client.configured()) throw Object.assign(new Error(`${def.label} の設定がありません(${client.missing().join('・')})`), { status: 400 });
    const { mergeSegments, minMinutes } = client.options();
    const timeZone = validTimeZone(client.cfg.timeZone);
    const map = await this.readMap(name);
    const entries = buildEntries(sessions, { from, to, mergeSegments, minMs: minMinutes * 60000, onlyDone: true });
    const create = [];
    const update = [];
    const del = [];
    let unchanged = 0;
    let skipped = 0;
    const view = (e, extra = {}) => ({ key: e.key, start: e.start, end: e.end, title: e.title, project: e.project, minutes: Math.round(e.ms / 60000), ...extra });
    for (const raw of entries) {
      const e = { ...raw, localDate: localDate(raw.start, timeZone) };
      const body = client.payload(e);
      if (!body) {
        skipped++;
        continue;
      }
      const hash = sha(body);
      const rec = map[e.key];
      if (!rec) create.push({ ...view(e), hash, entry: e });
      else if (rec.hash !== hash) update.push({ ...view(e), hash, id: rec.id, etag: rec.etag, entry: e });
      else unchanged++;
    }
    const present = allKeys(sessions, { mergeSegments });
    const sessionIds = new Set(sessions.map((s) => s.id));
    for (const [key, rec] of Object.entries(map)) {
      const at = Date.parse(rec.start);
      if (!(at >= from && at < to) || present.has(key)) continue;
      // セッションごと消えたものは、古いログの自動削除の可能性があるので、最近のものだけ消す
      if (!sessionIds.has(rec.sessionId) && now - Date.parse(rec.end) > KEEP_MISSING_AFTER_DAYS * 86400000) continue;
      del.push({ key, id: rec.id, etag: rec.etag, start: rec.start, end: rec.end, title: rec.title, project: rec.project, minutes: Math.round((Date.parse(rec.end) - at) / 60000) });
    }
    const hash = sha({ name, dest: client.destination(), create: create.map((x) => [x.key, x.hash]), update: update.map((x) => [x.key, x.id, x.hash]), delete: del.map((x) => [x.key, x.id]) });
    return { target: name, label: def.label, status: client.status(), from, to, timeZone, create, update, delete: del, unchanged, skipped, hash };
  }

  // 画面と CLI に見せる文面
  previewText(plan, timeZone = plan.timeZone) {
    const line = (x) => `  ${fmtWhen(x, timeZone)}  ${x.project ? `[${x.project}] ` : ''}${x.title}(${x.minutes}分)`;
    const out = [`追加 ${plan.create.length}件・更新 ${plan.update.length}件・削除 ${plan.delete.length}件(変更なし ${plan.unchanged}件${plan.skipped ? `・記録先の決まらないもの ${plan.skipped}件` : ''})`];
    for (const [label, list] of [['追加', plan.create], ['更新', plan.update], ['削除', plan.delete]]) {
      if (list.length) out.push('', `${label}:`, ...list.map(line));
    }
    return out.join('\n');
  }

  // 一覧のとおりに送る。1件ずつ順に送り、送れたものから対応表に記録する(途中で失敗しても、次はその続きから)
  async apply(name, plan) {
    const client = this.get(name);
    const map = await this.readMap(name);
    const done = { created: 0, updated: 0, deleted: 0 };
    // create / update の戻り値は ID の文字列か { id, etag }
    const record = (e, r, hash, prevId) => {
      const { id = prevId, etag } = r && typeof r === 'object' ? r : { id: r ?? prevId };
      map[e.key] = { id, ...(etag ? { etag } : {}), hash, sessionId: e.sessionId, start: e.start, end: e.end, title: e.title, project: e.project, at: new Date().toISOString() };
    };
    try {
      for (const x of plan.create) {
        record(x.entry, await client.create(x.entry), x.hash);
        done.created++;
      }
      for (const x of plan.update) {
        try {
          record(x.entry, await client.update(x.id, x.entry, { etag: x.etag }), x.hash, x.id);
          done.updated++;
        } catch (err) {
          if (err.status !== 404 && err.status !== 410) throw err;
          // 相手側で消されていたら作り直す
          record(x.entry, await client.create(x.entry), x.hash);
          done.created++;
        }
      }
      for (const x of plan.delete) {
        try {
          await client.remove(x.id, { etag: x.etag });
        } catch (err) {
          if (err.status !== 404 && err.status !== 410) throw err; // 既に無いものは消えたことにする
        }
        delete map[x.key];
        done.deleted++;
      }
    } catch (err) {
      await this.writeMap(name, map);
      const msg = `${SYNC_BY_NAME[name].label} への記録が途中で止まりました(追加 ${done.created}件・更新 ${done.updated}件・削除 ${done.deleted}件は済み): ${err.message}`;
      throw Object.assign(new Error(msg), { status: err.status === 429 ? 429 : 502, done });
    }
    await this.writeMap(name, map);
    return done;
  }

  // 同じ記録先への送信は1本ずつ(同時に押されても二重に作らない)
  exclusive(name, fn) {
    const prev = this.locks.get(name) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(name, next.catch(() => {}));
    return next;
  }
}
