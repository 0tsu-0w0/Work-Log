// 表計算ソフト向けの書き出し(CSV と .xlsx)。1行 = 作業の区間1つ(unit=segment、既定)か、セッション1つ(unit=session)。
// 列: 日付・開始・終了(tz の時刻)・作業時間(分)・プロジェクト・ツール・タイトル・タスク・コミット数・モデル・トークン数・API 換算(USD)・セッション ID。
// 文字列はすべて秘匿情報を伏せてから書く。
// 区間ごとのときの割り振り: トークンとコストは1時間ごとの集計(store の usage)を、その1時間と最も重なる区間に入れる
//   (重ならなければ最も近い区間)。コミットは時刻の入る区間(次の区間の開始まで)に、時刻の無いものは最後の区間に入れる。
//   どちらも区間の合計がセッションの合計と一致する。サブエージェントの分は親のセッションに含める。
// 日時は tz の時刻(CSV は "YYYY-MM-DD HH:MM:SS"、.xlsx は日付のセル)。
// CSV: UTF-8(BOM 付き。Excel が文字コードを正しく判断するため)・行末 CRLF・RFC 4180 の引用(, " 改行を含むものは "" で囲む)。
//   式の注入対策: 文字列のセルが = + - @ タブ CR で始まるときは先頭に ' を付ける(数値のセルには付けない)。
// .xlsx の文字列はインライン文字列のセル(式として解釈されない)なので、' は付けずにそのまま書く。
// 実際に確かめたもの(2026-10-05): CSV を pandas 3.0.6 の read_csv(encoding="utf-8-sig"、parse_dates)で読み、列・日時・数値が .xlsx と
//   一致すること。LibreOffice 25.8.7.3 の headless 変換で CSV を「式を評価する」設定で取り込み、' を付けた =HYPERLINK(…) が文字列のまま、
//   日時が日付として読まれること(比べるため ' の無い =1+1 を同じ設定で取り込むと式になることも確かめた)。
// 確かめていないもの: Microsoft Excel・Google スプレッドシートでの CSV の取り込み。
import { mask } from './mask.js';
import { toolLabel } from './sources.js';
import { costOf } from './pricing.js';
import { buildXlsx, excelSerial } from './xlsx.js';

const HOUR_MS = 3600000;

export const COLUMNS = [
  { key: 'date', header: '日付', type: 'date', width: 12 },
  { key: 'start', header: '開始', type: 'datetime', width: 17 },
  { key: 'end', header: '終了', type: 'datetime', width: 17 },
  { key: 'minutes', header: '作業時間(分)', type: 'dec1', width: 13 },
  { key: 'project', header: 'プロジェクト', type: 'text', width: 18 },
  { key: 'tool', header: 'ツール', type: 'text', width: 14 },
  { key: 'title', header: 'タイトル', type: 'text', width: 48 },
  { key: 'tasks', header: 'タスク', type: 'text', width: 18 },
  { key: 'commits', header: 'コミット数', type: 'int', width: 11 },
  { key: 'model', header: 'モデル', type: 'text', width: 24 },
  { key: 'tokens', header: 'トークン数', type: 'int', width: 13 },
  { key: 'usd', header: 'API換算(USD)', type: 'dec4', width: 14 },
  { key: 'sessionId', header: 'セッションID', type: 'text', width: 38 },
];

// tz での壁時計の時刻(UTC として表したミリ秒)
function wallClock(ms, timeZone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

const tokensOf = (t) => (t[0] || 0) + (t[1] || 0) + (t[2] || 0) + (t[3] || 0) + (t[4] || 0); // 入力・出力・キャッシュ読込・キャッシュ書込(5分 / 1時間)

// usage のキー "時(UTC)|モデル|fast|us" を、区間の番号ごとに分ける
function splitUsage(usageList, segs) {
  const out = segs.map(() => ({ tokens: 0, usd: 0, priced: false, models: new Map() }));
  for (const usage of usageList) {
    for (const [key, t] of Object.entries(usage || {})) {
      const [hour, model, fast, us] = key.split('|');
      const h = Date.parse(`${hour}:00:00Z`);
      let best = segs.length - 1;
      let bestScore = -Infinity;
      segs.forEach((g, i) => {
        const a = Date.parse(g.start);
        const b = Date.parse(g.end);
        const overlap = Math.min(b, h + HOUR_MS) - Math.max(a, h);
        const score = overlap > 0 ? overlap : -Math.max(a - (h + HOUR_MS), h - b, 0); // 重ならなければ離れている時間の分だけ低く
        if (score > bestScore) [best, bestScore] = [i, score];
      });
      const o = out[Math.max(best, 0)];
      const n = tokensOf(t);
      o.tokens += n;
      o.models.set(model, (o.models.get(model) || 0) + n);
      const usd = costOf(model, t, { fast: fast === 'fast', us: us === 'us' });
      if (usd !== null) {
        o.usd += usd;
        o.priced = true;
      }
    }
  }
  return out;
}

// コミットを区間の番号ごとに数える
function splitCommits(commits, segs) {
  const out = segs.map(() => 0);
  for (const c of commits || []) {
    const at = c.at ? Date.parse(c.at) : NaN;
    let idx = segs.length - 1;
    if (Number.isFinite(at)) {
      idx = 0;
      segs.forEach((g, i) => {
        if (Date.parse(g.start) <= at) idx = i;
      });
    }
    out[idx]++;
  }
  return out;
}

const modelsText = (m) => [...m.entries()].filter(([k]) => k && !k.startsWith('<')).sort((a, b) => b[1] - a[1]).map(([k]) => k).join(', ');

// sessions: store.sessions() の形 / subagents: store.subagentIndex()(親の ID → サブエージェントの解析結果)
// from / to(ミリ秒): 区間(セッション)の開始がこの範囲に入るものだけ。返す行の日時は UTC のミリ秒(書き出すときに tz で変換する)
export function exportRows(sessions, { from = -Infinity, to = Infinity, unit = 'segment', subagents = new Map() } = {}) {
  const rows = [];
  for (const s of sessions) {
    const segs = (s.segments || []).filter((g) => g.start && g.end);
    if (!segs.length) continue;
    const usage = splitUsage([s.usage, ...(subagents.get(s.id) || []).map((x) => x.usage)], segs);
    const commits = splitCommits(s.commitList, segs);
    const tasks = (s.tasks || []).map((t) => t.label || t.id).filter(Boolean).join(', ');
    const base = { project: s.project || '', tool: toolLabel(s.tool || 'claude'), title: s.displayTitle || s.title || '(無題)', tasks, sessionId: s.id };
    const parts = unit === 'session'
      ? [{ start: segs[0].start, end: segs.at(-1).end, ms: Number.isFinite(s.activeMs) ? s.activeMs : segs.reduce((n, g) => n + (Date.parse(g.end) - Date.parse(g.start)), 0), idx: segs.map((_, i) => i) }]
      : segs.map((g, i) => ({ start: g.start, end: g.end, ms: Date.parse(g.end) - Date.parse(g.start), idx: [i] }));
    for (const p of parts) {
      const start = Date.parse(p.start);
      if (start < from || start >= to) continue;
      const models = new Map();
      let tokens = 0;
      let usd = 0;
      let priced = false;
      for (const i of p.idx) {
        tokens += usage[i].tokens;
        usd += usage[i].usd;
        priced ||= usage[i].priced;
        for (const [k, v] of usage[i].models) models.set(k, (models.get(k) || 0) + v);
      }
      rows.push({
        ...base,
        start,
        end: Date.parse(p.end),
        minutes: Math.round((p.ms / 60000) * 10) / 10,
        commits: p.idx.reduce((n, i) => n + commits[i], 0),
        model: modelsText(models),
        tokens,
        usd: priced ? Math.round(usd * 10000) / 10000 : null,
      });
    }
  }
  rows.sort((a, b) => a.start - b.start || a.sessionId.localeCompare(b.sessionId));
  // 文字列はすべて伏せる
  return rows.map((r) => ({ ...r, project: mask(r.project), tool: mask(r.tool), title: mask(r.title), tasks: mask(r.tasks), model: mask(r.model), sessionId: mask(r.sessionId) }));
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (w) => { const d = new Date(w); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const hms = (w) => { const d = new Date(w); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };

// 式として解釈されうる文字列の先頭に ' を付ける(OWASP の CSV Injection の対策)
export const neutralize = (s) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

// RFC 4180 の引用
export const csvField = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(rows, { timeZone = 'UTC' } = {}) {
  const lines = [COLUMNS.map((c) => csvField(c.header))];
  for (const r of rows) {
    const ws = wallClock(r.start, timeZone);
    const we = wallClock(r.end, timeZone);
    const v = {
      date: ymd(ws), start: `${ymd(ws)} ${hms(ws)}`, end: `${ymd(we)} ${hms(we)}`,
      minutes: r.minutes.toFixed(1), commits: String(r.commits), tokens: String(r.tokens), usd: r.usd === null ? '' : r.usd.toFixed(4),
    };
    lines.push(COLUMNS.map((c) => (c.key in v ? v[c.key] : csvField(neutralize(String(r[c.key] ?? ''))))));
  }
  return `﻿${lines.map((l) => l.join(',')).join('\r\n')}\r\n`;
}

export function toXlsx(rows, { timeZone = 'UTC', now = Date.now() } = {}) {
  const data = rows.map((r) => {
    const ws = wallClock(r.start, timeZone);
    const we = wallClock(r.end, timeZone);
    const day = Date.UTC(new Date(ws).getUTCFullYear(), new Date(ws).getUTCMonth(), new Date(ws).getUTCDate());
    const v = { ...r, date: excelSerial(day), start: excelSerial(ws), end: excelSerial(we) };
    return COLUMNS.map((c) => v[c.key]);
  });
  return buildXlsx({ sheetName: '作業記録', columns: COLUMNS, rows: data, now });
}
