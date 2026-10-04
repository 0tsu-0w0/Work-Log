// カレンダー(.ics)とカレンダー・工数管理サービスへの記録に使う「予定」の組み立て。
// 1つの予定 = セッションの1区間(30分以上空いたら別の区間)。mergeSegments のときはセッション1つで1件。
// 予定のキーは "<セッションID>-<区間の番号>"(まとめるときは "<セッションID>")。区間は後ろにしか増えないので番号は変わらない。
import { maskDeep } from '../mask.js';
import { toolLabel } from '../sources.js';
import { zonedMidnight } from '../report.js';

const DAY_MS = 86400000;
const MAX_COMMITS = 10;

export const segmentKey = (sessionId, index) => (index === null ? String(sessionId) : `${sessionId}-${index}`);

// 予定の説明文(プレーンテキスト)。コミットは区間の中のものだけを書く(まとめるときはセッション全体)
function describe(s, { start, end, index }) {
  const all = index === null;
  const lines = [`プロジェクト: ${s.project}`, `ツール: ${toolLabel(s.tool || 'claude')}`];
  if (s.gitBranch) lines.push(`ブランチ: ${s.gitBranch}`);
  const a = Date.parse(start);
  const b = Date.parse(end) + 5 * 60000; // 区間の最後の記録の少し後に記録されるコミットも含める
  const commits = (s.commitList || []).filter((c) => all || !c.at || (Date.parse(c.at) >= a && Date.parse(c.at) <= b));
  if (commits.length) {
    lines.push(`コミット: ${commits.length}件`);
    for (const c of commits.slice(0, MAX_COMMITS)) lines.push(`- ${String(c.hash || '').slice(0, 7)} ${c.subject || ''}`.trimEnd());
    if (commits.length > MAX_COMMITS) lines.push(`- ほか ${commits.length - MAX_COMMITS}件`);
  }
  const tasks = (s.tasks || []).map((t) => t.label || t.id).filter(Boolean);
  if (tasks.length) lines.push(`タスク: ${tasks.join(', ')}`);
  lines.push('(Work Log で記録)');
  return lines.join('\n');
}

// セッション(store.sessions() の形)から予定を作る。秘匿情報は伏せてから返す。
//   from / to(ミリ秒): 区間の開始がこの範囲に入るものだけ / mergeSegments: セッションごとに1件
//   minMs: これより短いものは除く / onlyDone: 終わったセッションだけ
export function buildEntries(sessions, { from = -Infinity, to = Infinity, mergeSegments = false, minMs = 0, onlyDone = false } = {}) {
  const out = [];
  for (const s of sessions) {
    if (onlyDone && s.status !== 'done') continue;
    const segs = (s.segments || []).filter((g) => g.start && g.end);
    if (!segs.length) continue;
    const parts = mergeSegments
      ? [{ index: null, start: segs[0].start, end: segs.at(-1).end, ms: segs.reduce((n, g) => n + (Date.parse(g.end) - Date.parse(g.start)), 0) }]
      : segs.map((g, index) => ({ index, start: g.start, end: g.end, ms: Date.parse(g.end) - Date.parse(g.start) }));
    for (const p of parts) {
      const at = Date.parse(p.start);
      if (at < from || at >= to || p.ms < minMs) continue;
      out.push(maskDeep({
        key: segmentKey(s.id, p.index),
        sessionId: s.id,
        index: p.index,
        start: new Date(p.start).toISOString(),
        end: new Date(p.end).toISOString(),
        ms: p.ms,
        title: s.displayTitle || s.title || '(無題)',
        project: s.project || '',
        tool: s.tool || 'claude',
        description: describe(s, p),
      }));
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
}

// 手元にあるすべての予定のキー(進行中・短いものも含む)。消えた区間を見分けるのに使う
export function allKeys(sessions, { mergeSegments = false } = {}) {
  const keys = new Set();
  for (const s of sessions) {
    const n = (s.segments || []).length;
    if (!n) continue;
    if (mergeSegments) keys.add(segmentKey(s.id, null));
    else for (let i = 0; i < n; i++) keys.add(segmentKey(s.id, i));
  }
  return keys;
}

// 期間の指定を解釈する。"YYYY-MM-DD"(tz の0時。to はその日を含む)か ISO 8601 の日時。
// 省いたときは to = 今、from = to の defaultDays 日前。maxDays 日を超える期間は断る
export function resolveRange({ from, to } = {}, { timeZone = 'UTC', defaultDays = 30, maxDays = 366, now = Date.now() } = {}) {
  const parse = (v, isTo) => {
    if (v === undefined || v === null || v === '') return null;
    const str = String(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      const t = zonedMidnight(str, timeZone);
      if (!Number.isFinite(t)) throw new Error(`日付として読めません: ${str}`);
      return isTo ? zonedMidnight(new Date(Date.parse(`${str}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10), timeZone) : t;
    }
    const t = Date.parse(str);
    if (!Number.isFinite(t)) throw new Error(`日時として読めません: ${str.slice(0, 40)}(YYYY-MM-DD か ISO 8601 で指定してください)`);
    return t;
  };
  const toMs = parse(to, true) ?? now;
  const fromMs = parse(from, false) ?? toMs - defaultDays * DAY_MS;
  if (fromMs >= toMs) throw new Error('期間の開始が終わりより後になっています');
  if (toMs - fromMs > maxDays * DAY_MS) throw new Error(`期間が長すぎます(最大 ${maxDays} 日)`);
  return { from: fromMs, to: toMs };
}
