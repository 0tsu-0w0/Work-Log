// 日報・週報を「ページ」として書き出す形式(Markdown と Confluence の storage format(XHTML))。
// Slack などのチャット向け(report.js)と違い、メッセージではなくドキュメントなので、
// セッションは表にして、既定では 500 件まで載せる。
// 返す message は { kind: 'report', period, start, title, body }。period と start(期間の開始日)は、
// 同じ期間を送り直したときに同じページを更新するための目印になる(docutil.js の PageMap)。
import { reportTitle, formatDuration as dur } from './report.js';
import { toolLabel } from './sources.js';

const FOOTER = 'ローカルの AI コーディングツールのセッションログから Work Log で作成';
const MAX_SESSIONS = 500;

// ---------------------------------------------------------------- 逃がし方
// Markdown: 書式・表・リンク・HTML・数式になる記号を \ で逃がす。行頭の # + - 1. も見出し・箇条書きになるので逃がす
export const mdEsc = (s) =>
  String(s ?? '')
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/[\\`*_[\]<>|~&$]/g, (c) => `\\${c}`)
    .replace(/^(\s*)([#+-])/, '$1\\$2')
    .replace(/^(\s*\d+)([.)])/, '$1\\$2')
    // esa・Qiita Team は @名前 でメンバーに通知が飛ぶ(\ で逃がせるかは確かめられないので、全角にする)
    .replace(/@(?=[\w.-])/g, '＠');

const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
const mdLink = (label, url) => (isHttp(url) ? `[${mdEsc(label)}](${String(url).replace(/[()<>\s\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)})` : mdEsc(label));

// XML(Confluence): & < > " ' を逃がし、XML に使えない制御文字は取り除く
const XML_ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// eslint-disable-next-line no-control-regex
export const xEsc = (s) => String(s ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g, '').replace(/\r\n|\r|\n/g, ' ').replace(/[&<>"']/g, (c) => XML_ENT[c]);
const xLink = (label, url) => (isHttp(url) ? `<a href="${xEsc(url)}">${xEsc(label)}</a>` : xEsc(label));

// ---------------------------------------------------------------- 題名
// "2026-10-04(日)" のようにスラッシュを使わない書き方(esa の記事名や Obsidian のファイル名に / は使えない)
function hyphenTitle(range) {
  const f = (ms, withYear) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('ja-JP', { timeZone: range.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${withYear ? `${p.year}-` : ''}${p.month}-${p.day}(${p.weekday})`;
  };
  return range.period === 'week' ? `週報 ${f(range.from, true)} 〜 ${f(range.to - 1)}` : `日報 ${f(range.from, true)}`;
}

// ISO 8601 の週(月曜始まり)の年と番号
function isoWeek(start) {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3); // その週の木曜日
  const y = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(y, 0, 4));
  return { year: y, week: 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7) };
}

// Obsidian のノートのファイル名: "2026-10-04 日報.md" / "2026-W40 週報.md"
export function noteName(period, start) {
  if (period === 'week') {
    const { year, week } = isoWeek(start);
    return `${year}-W${String(week).padStart(2, '0')} 週報.md`;
  }
  return `${start} 日報.md`;
}

// ---------------------------------------------------------------- 中身
function model(report, { includeCost, maxSessions }) {
  const { totals, range } = report;
  const time = (iso) => new Intl.DateTimeFormat('ja-JP', { timeZone: range.timeZone, ...(range.period === 'week' ? { month: 'numeric', day: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const shown = report.sessions.slice(0, maxSessions);
  return {
    summary: report.sessions.length
      ? `作業 ${dur(totals.activeMs)}・${totals.sessions}セッション・${totals.commits}コミット${includeCost && totals.usd != null ? `・API換算 $${totals.usd.toFixed(2)}(参考値)` : ''}`
      : 'この期間の作業はありません。',
    projects: report.projects.map((p) => ({ name: p.project, time: dur(p.activeMs), sessions: p.sessions, commits: p.commits })),
    tasks: report.tasks.map((t) => ({ label: t.label, url: t.url, issue: t.issue ? `${t.issue.title}(${t.issue.stateLabel})` : '', time: dur(t.activeMs) })),
    sessions: shown.map((s) => ({ start: time(s.start), title: s.title, tool: s.tool && s.tool !== 'claude' ? `(${toolLabel(s.tool)})` : '', project: s.project, time: dur(s.activeMs), commits: s.commits })),
    hidden: report.sessions.length - shown.length,
  };
}

function markdown(m) {
  const row = (cells) => `| ${cells.join(' | ')} |`;
  const out = [mdEsc(m.summary)];
  if (m.projects.length) {
    out.push('## プロジェクト別', [row(['プロジェクト', '作業時間', 'セッション', 'コミット']), row(['---', '---:', '---:', '---:']), ...m.projects.map((p) => row([mdEsc(p.name), p.time, p.sessions, p.commits]))].join('\n'));
  }
  if (m.tasks.length) {
    out.push('## タスク', m.tasks.map((t) => `- ${mdLink(t.label, t.url)}${t.issue ? ` ${mdEsc(t.issue)}` : ''}  ${t.time}`).join('\n'));
  }
  if (m.sessions.length) {
    const rows = [row(['開始', 'セッション', 'プロジェクト', '作業時間', 'コミット']), row(['---', '---', '---', '---:', '---:']), ...m.sessions.map((s) => row([s.start, `${mdEsc(s.title)}${mdEsc(s.tool)}`, mdEsc(s.project), s.time, s.commits]))];
    out.push('## セッション', rows.join('\n'));
    if (m.hidden) out.push(`ほか ${m.hidden} セッション`);
  }
  out.push('---', `*${FOOTER}*`);
  return out.join('\n\n');
}

function storage(m) {
  const table = (head, rows) => `<table><tbody><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const out = [`<p>${xEsc(m.summary)}</p>`];
  if (m.projects.length) out.push('<h2>プロジェクト別</h2>', table(['プロジェクト', '作業時間', 'セッション', 'コミット'], m.projects.map((p) => [xEsc(p.name), p.time, p.sessions, p.commits])));
  if (m.tasks.length) out.push('<h2>タスク</h2>', `<ul>${m.tasks.map((t) => `<li>${xLink(t.label, t.url)}${t.issue ? ` ${xEsc(t.issue)}` : ''}  ${t.time}</li>`).join('')}</ul>`);
  if (m.sessions.length) {
    out.push('<h2>セッション</h2>', table(['開始', 'セッション', 'プロジェクト', '作業時間', 'コミット'], m.sessions.map((s) => [s.start, `${xEsc(s.title)}${xEsc(s.tool)}`, xEsc(s.project), s.time, s.commits])));
    if (m.hidden) out.push(`<p>ほか ${m.hidden} セッション</p>`);
  }
  out.push('<hr />', `<p><em>${xEsc(FOOTER)}</em></p>`);
  return out.join('');
}

const base = (report, o) => ({ kind: 'report', period: report.range.period, start: report.range.start, m: model(report, { includeCost: Boolean(o.includeCost), maxSessions: Number(o.maxSessions) || MAX_SESSIONS }) });
const previewOf = (title, md) => `# ${mdEsc(title)}\n\n${md}`;

// Confluence: 本文は storage format(XHTML)。プレビューは同じ内容を Markdown で見せる
export function toConfluence(report, o = {}) {
  const { m, ...head } = base(report, o);
  const title = `Work Log ${reportTitle(report.range)}`;
  return { ...head, title, body: storage(m), preview: previewOf(title, markdown(m)) };
}

// esa / Qiita Team: 本文は Markdown
export function toMarkdownPage(report, o = {}) {
  const { m, ...head } = base(report, o);
  const title = `Work Log ${hyphenTitle(report.range)}`;
  const body = markdown(m);
  return { ...head, title, body, preview: previewOf(title, body) };
}
export const toEsa = toMarkdownPage;
export const toQiitaTeam = toMarkdownPage;

// Obsidian: Markdown に YAML のプロパティ(date / period / tags)を付ける
export function toObsidian(report, o = {}) {
  const { m, ...head } = base(report, o);
  const title = `Work Log ${hyphenTitle(report.range)}`;
  const md = markdown(m);
  return { ...head, title, body: `---\ndate: ${head.start}\nperiod: ${head.period}\ntags: [work-log]\n---\n\n${md}\n`, preview: previewOf(title, md) };
}

// Obsidian のセッション終了の通知: その日の「<日付> セッション.md」に1行足す
export function sessionEndObsidian(s, { includeCost = false, timeZone } = {}) {
  const at = new Date(s.end || Date.now());
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  const hm = new Intl.DateTimeFormat('ja-JP', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  const parts = [mdEsc(s.project), dur(s.activeMs), `${s.commits}コミット`];
  if (s.tool && s.tool !== 'claude') parts.push(mdEsc(toolLabel(s.tool)));
  if (includeCost && s.cost) parts.push(`API換算 $${s.cost.usd.toFixed(2)}(参考値)`);
  const tasks = (s.tasks || []).map((t) => mdLink(t.label, t.url));
  return { kind: 'session', date, line: `- ${hm} ${mdEsc(s.displayTitle || s.title)} — ${parts.join('・')}${tasks.length ? `・タスク: ${tasks.join(', ')}` : ''}` };
}

// Markdown をプレーンテキストに戻す(画面のプレビュー用)
export function plainFromMarkdown(text) {
  const unesc = (t) => t.replace(/\\([\\`*_[\]<>|~&$#+.)-])/g, '$1');
  return text
    .split('\n')
    .filter((l) => !/^\|\s*:?-{3,}/.test(l) && l !== '---')
    .map((l) => {
      let t = l.replace(/^#{1,6}\s+/, '').replace(/\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/g, '$1 ($2)');
      if (/^\|.*\|$/.test(t)) t = t.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim()).join(' / ');
      if (/^\*.*\*$/.test(t)) t = t.slice(1, -1);
      return unesc(t);
    })
    .join('\n');
}
