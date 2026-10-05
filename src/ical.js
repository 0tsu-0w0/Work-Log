// iCalendar(RFC 5545)の書き出し。外部には何も送らず、カレンダーアプリに取り込める .ics を作るだけ。
// 準拠している点: 行末は CRLF / 1行 75 オクテットで折り返し(続きの行は空白1つで始める。UTF-8 の文字の途中では切らない)/
// TEXT の \ ; , 改行のエスケープ / UID はセッションの区間ごとに固定("<セッションID>-<区間の番号>@work-log")/
// DTSTAMP・DTSTART・DTEND は UTC("Z" 付き)。長さ0の区間は終わりを1分後にする(DTEND は DTSTART より後でなければならない)。
import { buildEntries } from './sync/entries.js';

const CRLF = '\r\n';
const MAX_OCTETS = 75;

// TEXT 型の値のエスケープ(RFC 5545 3.3.11)
export function escapeText(v) {
  return String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// 75 オクテットを超える行を折り返す(RFC 5545 3.1)。続きの行の先頭の空白も 75 オクテットに数える
export function foldLine(line) {
  if (Buffer.byteLength(line) <= MAX_OCTETS) return line;
  const out = [];
  let cur = '';
  let size = 0;
  let limit = MAX_OCTETS;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (size + n > limit) {
      out.push(cur);
      cur = '';
      size = 0;
      limit = MAX_OCTETS - 1;
    }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out.join(`${CRLF} `);
}

// 2026-10-04T01:02:03.456Z → 20261004T010203Z
export function icsDate(v) {
  return new Date(v).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// 予定のキー(sync/entries.js)から UID を作る。.ics の書き出しと CalDAV への記録で同じものを使う
export const eventUid = (key) => `${key}@work-log`;

// 予定1件(buildEntries の形)の VEVENT の行(折り返し前)
export function eventLines(e, { now = Date.now() } = {}) {
  const start = Date.parse(e.start);
  const end = Math.max(Date.parse(e.end), start + 60000);
  return [
    'BEGIN:VEVENT',
    `UID:${eventUid(e.key)}`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${escapeText(e.title)}`,
    `DESCRIPTION:${escapeText(e.description)}`,
    ...(e.project ? [`CATEGORIES:${escapeText(e.project)}`] : []),
    'END:VEVENT',
  ];
}

const HEAD = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Work Log//Work Log//JA', 'CALSCALE:GREGORIAN'];
const finish = (lines) => lines.map(foldLine).join(CRLF) + CRLF;

// CalDAV に置く予定1件分の iCalendar。CalDAV のカレンダーに置くものには METHOD を書いてはいけない(RFC 4791 4.1)
export function buildEvent(e, { now = Date.now() } = {}) {
  return finish([...HEAD, ...eventLines(e, { now }), 'END:VCALENDAR']);
}

// sessions は store.sessions() の形。from / to(ミリ秒)に区間の開始が入るものを書き出す。文字列は buildEntries で伏せてある
export function buildCalendar(sessions, { from, to, now = Date.now(), name = 'Work Log' } = {}) {
  const lines = [...HEAD, 'METHOD:PUBLISH', `X-WR-CALNAME:${escapeText(name)}`];
  for (const e of buildEntries(sessions, { from, to })) lines.push(...eventLines(e, { now }));
  lines.push('END:VCALENDAR');
  return finish(lines);
}
