// 日報・週報: 期間内の作業(時間・セッション・コミット・プロジェクト・タスク・コスト)をまとめ、
// Slack の mrkdwn とターミナル向けのプレーンテキストで書き出す。
// 時間は期間に入る部分だけを数え、コミットは時刻が期間内のものを数える。
import { toolLabel } from './sources.js';

// Claude Code 以外のツールのセッションには、ツール名を添える
const otherTool = (s) => (s.tool && s.tool !== 'claude' ? `(${toolLabel(s.tool)})` : '');

// tz での "YYYY-MM-DD" の 0 時(UTC のミリ秒)。夏時間の切り替えにも対応するため、ずれを2回直す
export function zonedMidnight(dateStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  let t = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) t = Date.UTC(y, m - 1, d) - tzOffset(t, timeZone);
  return t;
}

function tzOffset(ts, timeZone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ts))
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}

export function validTimeZone(tz) {
  try {
    return tz ? new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
}

// tz での今日の日付 "YYYY-MM-DD"
export function todayIn(timeZone, now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

// period: "day" はその日、"week" はその日を含む月曜始まりの1週間
export function periodRange({ period = 'day', date, timeZone }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('日付は YYYY-MM-DD で指定してください');
  let start = date;
  if (period === 'week') {
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0=日
    const back = (dow + 6) % 7;
    start = new Date(Date.parse(`${date}T12:00:00Z`) - back * 86400000).toISOString().slice(0, 10);
  }
  const days = period === 'week' ? 7 : 1;
  const end = new Date(Date.parse(`${start}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  return { period, start, from: zonedMidnight(start, timeZone), to: zonedMidnight(end, timeZone), timeZone };
}

const clip = (segments, from, to) => segments.reduce((n, g) => n + Math.max(0, Math.min(Date.parse(g.end), to) - Math.max(Date.parse(g.start), from)), 0);

// 期間内の作業を集計する。tasks は store.tasks() の結果(課題の情報付き)、costs は store.costs() の結果
export function buildReport({ sessions, tasks = [], costs = null, range }) {
  const { from, to } = range;
  const rows = [];
  for (const s of sessions) {
    const activeMs = clip(s.segments || [], from, to);
    const commitTimes = [...(s.commitList || []).map((c) => c.at), ...(s.quietCommits || [])].map((x) => Date.parse(x)).filter((x) => x >= from && x < to);
    if (!activeMs && !commitTimes.length) continue;
    rows.push({ id: s.id, title: s.displayTitle || s.title, project: s.project, tool: s.tool || 'claude', start: s.start, activeMs, commits: commitTimes.length, status: s.status });
  }
  rows.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const byProject = new Map();
  for (const r of rows) {
    const p = byProject.get(r.project) || { project: r.project, activeMs: 0, sessions: 0, commits: 0 };
    p.activeMs += r.activeMs;
    p.sessions++;
    p.commits += r.commits;
    byProject.set(r.project, p);
  }
  const ids = new Set(rows.map((r) => r.id));
  const relTasks = tasks
    .map((t) => ({ ...t, activeMs: t.sessions.filter((s) => ids.has(s.id)).reduce((n, s) => n + (rows.find((r) => r.id === s.id)?.activeMs || 0), 0) }))
    .filter((t) => t.activeMs > 0)
    .sort((a, b) => b.activeMs - a.activeMs);
  return {
    range,
    sessions: rows,
    projects: [...byProject.values()].sort((a, b) => b.activeMs - a.activeMs),
    tasks: relTasks,
    totals: {
      activeMs: rows.reduce((n, r) => n + r.activeMs, 0),
      sessions: rows.length,
      commits: rows.reduce((n, r) => n + r.commits, 0),
      usd: costs ? costs.buckets.reduce((n, b) => n + b.usd, 0) : null,
    },
  };
}

// ドキュメント系の送り先(docreport.js)からも使う
export { dur as formatDuration, title as reportTitle };

function dur(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}`;
}

function title(range) {
  const fmt = (ms, withYear) =>
    new Intl.DateTimeFormat('ja-JP', { timeZone: range.timeZone, ...(withYear ? { year: 'numeric' } : {}), month: 'numeric', day: 'numeric', weekday: 'short' }).format(new Date(ms));
  return range.period === 'week' ? `週報 ${fmt(range.from, true)} 〜 ${fmt(range.to - 1)}` : `日報 ${fmt(range.from, true)}`;
}

// Slack の mrkdwn で特別な意味を持つ & < > を逃がす
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, ' ');

// Slack 用(blocks と、通知などに使われる text)。セクション1つの文字数上限(3000)を超えないよう分ける
export function toSlack(report, { includeCost = false, maxSessions = 20 } = {}) {
  const { totals, range } = report;
  const time = (iso) => new Intl.DateTimeFormat('ja-JP', { timeZone: range.timeZone, ...(range.period === 'week' ? { month: 'numeric', day: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const head = `*Work Log ${title(range)}*`;
  const summary = report.sessions.length
    ? `作業 ${dur(totals.activeMs)}・${totals.sessions}セッション・${totals.commits}コミット${includeCost && totals.usd != null ? `・API 換算 $${totals.usd.toFixed(2)}` : ''}`
    : 'この期間の作業はありません。';
  const sections = [`${head}\n${summary}`];
  if (report.projects.length) sections.push(['*プロジェクト別*', ...report.projects.map((p) => `• ${esc(p.project)}  ${dur(p.activeMs)}(${p.sessions}セッション・${p.commits}コミット)`)].join('\n'));
  if (report.tasks.length) {
    sections.push(
      [
        '*タスク*',
        ...report.tasks.map((t) => {
          const name = t.url ? `<${t.url.replace(/[<>|]/g, encodeURIComponent)}|${esc(t.label)}>` : esc(t.label);
          const info = t.issue ? ` ${esc(t.issue.title)}(${esc(t.issue.stateLabel)})` : '';
          return `• ${name}${info}  ${dur(t.activeMs)}`;
        }),
      ].join('\n'),
    );
  }
  if (report.sessions.length) {
    const shown = report.sessions.slice(0, maxSessions);
    const lines = shown.map((s) => `• ${time(s.start)} ${esc(s.title)} — ${esc(s.project)}・${dur(s.activeMs)}${s.commits ? `・${s.commits}コミット` : ''}${otherTool(s)}`);
    if (report.sessions.length > shown.length) lines.push(`ほか ${report.sessions.length - shown.length} セッション`);
    let cur = '*セッション*';
    for (const l of lines) {
      if ((cur + '\n' + l).length > 2900) {
        sections.push(cur);
        cur = l;
      } else cur += '\n' + l;
    }
    sections.push(cur);
  }
  const blocks = sections.flatMap((text, i) => [...(i ? [{ type: 'divider' }] : []), { type: 'section', text: { type: 'mrkdwn', text } }]);
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'ローカルの AI コーディングツールのセッションログから Work Log で作成' }] });
  return { text: `Work Log ${title(range)}: ${summary}`, blocks, preview: sections.join('\n\n') };
}

// ターミナル向け: Slack の mrkdwn(*太字*、<URL|名前>、&lt; など)をプレーンテキストに戻す
export function plainFromMrkdwn(text) {
  return text.replace(/\*/g, '').replace(/<([^|>]+)\|([^>]+)>/g, '$2 ($1)').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// セッション終了の通知(1セッション分)
export function sessionEndMessage(s, { includeCost = false } = {}) {
  const parts = [esc(s.project), dur(s.activeMs), `${s.commits}コミット`];
  if (s.tool && s.tool !== 'claude') parts.push(toolLabel(s.tool));
  if (includeCost && s.cost) parts.push(`API 換算 $${s.cost.usd.toFixed(2)}`);
  const tasks = (s.tasks || []).map((t) => (t.url ? `<${t.url.replace(/[<>|]/g, encodeURIComponent)}|${esc(t.label)}>` : esc(t.label)));
  const text = `セッション終了: *${esc(s.displayTitle || s.title)}*\n${parts.join('・')}${tasks.length ? `\nタスク: ${tasks.join(', ')}` : ''}`;
  return { text: `セッション終了: ${s.displayTitle || s.title}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

// ---------------------------------------------------------------- Discord
// Discord の Markdown で意味を持つ記号を逃がす(メンションは送信側で allowed_mentions を空にして止める)
const dEsc = (s) => String(s ?? '').replace(/\n/g, ' ').replace(/([\\*_~`|>[\]()#-])/g, '\\$1');
const dLink = (label, url) => (url ? `[${dEsc(label)}](${String(url).replace(/[()\s]/g, encodeURIComponent)})` : dEsc(label));
const DISCORD_COLOR = 0xd97757; // 見出しの帯の色(画面のアクセント色と同じ)
const LIMITS = { title: 256, description: 4096, footer: 2048, total: 6000, embeds: 10 };

// 日報・週報を embeds にする。セクションごとに1つの embed、合計 6000 文字・10 個までに収める
export function toDiscord(report, { includeCost = false, maxSessions = 20 } = {}) {
  const { totals, range } = report;
  const time = (iso) => new Intl.DateTimeFormat('ja-JP', { timeZone: range.timeZone, ...(range.period === 'week' ? { month: 'numeric', day: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const summary = report.sessions.length
    ? `作業 ${dur(totals.activeMs)}・${totals.sessions}セッション・${totals.commits}コミット${includeCost && totals.usd != null ? `・API 換算 $${totals.usd.toFixed(2)}` : ''}`
    : 'この期間の作業はありません。';
  const sections = [];
  if (report.projects.length) sections.push(['プロジェクト別', report.projects.map((p) => `• ${dEsc(p.project)}  ${dur(p.activeMs)}(${p.sessions}セッション・${p.commits}コミット)`)]);
  if (report.tasks.length) {
    sections.push(['タスク', report.tasks.map((t) => `• ${dLink(t.label, t.url)}${t.issue ? ` ${dEsc(t.issue.title)}(${dEsc(t.issue.stateLabel)})` : ''}  ${dur(t.activeMs)}`)]);
  }
  if (report.sessions.length) {
    const shown = report.sessions.slice(0, maxSessions);
    const lines = shown.map((s) => `• ${time(s.start)} ${dEsc(s.title)} — ${dEsc(s.project)}・${dur(s.activeMs)}${s.commits ? `・${s.commits}コミット` : ''}${otherTool(s)}`);
    if (report.sessions.length > shown.length) lines.push(`ほか ${report.sessions.length - shown.length} セッション`);
    sections.push(['セッション', lines]);
  }
  const footer = { text: 'ローカルの AI コーディングツールのセッションログから Work Log で作成' };
  const embeds = [{ title: `Work Log ${title(range)}`.slice(0, LIMITS.title), description: summary, color: DISCORD_COLOR }];
  let used = embeds[0].title.length + summary.length + footer.text.length;
  for (const [name, lines] of sections) {
    let desc = '';
    let dropped = 0;
    for (const l of lines) {
      const next = desc ? `${desc}\n${l}` : l;
      // 1つの embed の説明文の上限と、メッセージ全体の上限の両方に収める(収まらない行は件数だけ書く)
      if (next.length > LIMITS.description - 40 || used + name.length + next.length > LIMITS.total - 80) dropped++;
      else desc = next;
    }
    if (dropped) desc += `\n…ほか ${dropped} 行`;
    if (!desc || embeds.length >= LIMITS.embeds) break;
    embeds.push({ title: name, description: desc, color: DISCORD_COLOR });
    used += name.length + desc.length;
  }
  embeds[embeds.length - 1].footer = footer;
  const preview = embeds.map((e) => `**${e.title}**\n${e.description}`).join('\n\n');
  return { content: '', embeds, preview };
}

export function sessionEndDiscord(s, { includeCost = false } = {}) {
  const parts = [dEsc(s.project), dur(s.activeMs), `${s.commits}コミット`];
  if (s.tool && s.tool !== 'claude') parts.push(toolLabel(s.tool));
  if (includeCost && s.cost) parts.push(`API 換算 $${s.cost.usd.toFixed(2)}`);
  const tasks = (s.tasks || []).map((t) => dLink(t.label, t.url));
  const description = `${parts.join('・')}${tasks.length ? `\nタスク: ${tasks.join(', ')}` : ''}`;
  return { content: '', embeds: [{ title: `セッション終了: ${s.displayTitle || s.title}`.slice(0, LIMITS.title), description, color: DISCORD_COLOR }] };
}

// Discord の Markdown をプレーンテキストに戻す(画面のプレビュー・ターミナル用)
export function plainFromDiscord(text) {
  return text.replace(/\*\*/g, '').replace(/\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)').replace(/\\([\\*_~`|>[\]()#-])/g, '$1');
}

// ---------------------------------------------------------------- Microsoft Teams
// Adaptive Card(TextBlock の Markdown は太字・斜体・リスト・リンクのみ。見出しや表は使えない)。
// メッセージ全体は 28KB まで(Incoming Webhook / Workflows)なので、収まるようにセッション一覧を削る
const TEAMS_MAX_BYTES = 26000;
// Markdown として解釈される記号は、見た目の近い全角に置き換える(TextBlock では \ による逃がしが効かないため)
const tEsc = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/[*_[\]]/g, (c) => ({ '*': '＊', _: '＿', '[': '［', ']': '］' })[c]);
// URL の中の括弧と空白は %xx にする(encodeURIComponent は括弧を変えないため)
const tLink = (label, url) =>
  url && /^https?:\/\//.test(url) ? `[${tEsc(label)}](${String(url).replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)})` : tEsc(label);

function teamsCard(body) {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', msteams: { width: 'Full' }, body },
      },
    ],
  };
}

const tb = (text, extra = {}) => ({ type: 'TextBlock', text, wrap: true, ...extra });

export function toTeams(report, { includeCost = false, maxSessions = 20 } = {}) {
  const { totals, range } = report;
  const time = (iso) => new Intl.DateTimeFormat('ja-JP', { timeZone: range.timeZone, ...(range.period === 'week' ? { month: 'numeric', day: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const summary = report.sessions.length
    ? `作業 ${dur(totals.activeMs)}・${totals.sessions}セッション・${totals.commits}コミット${includeCost && totals.usd != null ? `・API 換算 $${totals.usd.toFixed(2)}` : ''}`
    : 'この期間の作業はありません。';
  const sections = [];
  if (report.projects.length) sections.push(['プロジェクト別', report.projects.map((p) => `${tEsc(p.project)}  ${dur(p.activeMs)}(${p.sessions}セッション・${p.commits}コミット)`)]);
  if (report.tasks.length) sections.push(['タスク', report.tasks.map((t) => `${tLink(t.label, t.url)}${t.issue ? ` ${tEsc(t.issue.title)}(${tEsc(t.issue.stateLabel)})` : ''}  ${dur(t.activeMs)}`)]);
  let lines = report.sessions.map((s) => `${time(s.start)} ${tEsc(s.title)} — ${tEsc(s.project)}・${dur(s.activeMs)}${s.commits ? `・${s.commits}コミット` : ''}${otherTool(s)}`);
  const build = (sessionLines, hidden) => {
    const all = [...sections, ...(sessionLines.length ? [['セッション', hidden ? [...sessionLines, `ほか ${hidden} セッション`] : sessionLines]] : [])];
    const body = [tb(`Work Log ${title(range)}`, { weight: 'Bolder', size: 'Medium' }), tb(summary, { spacing: 'Small' })];
    for (const [name, ls] of all) body.push(tb(name, { weight: 'Bolder', spacing: 'Medium' }), tb(ls.map((l) => `- ${l}`).join('\r'), { spacing: 'Small' }));
    body.push(tb('ローカルの AI コーディングツールのセッションログから Work Log で作成', { size: 'Small', isSubtle: true, spacing: 'Medium' }));
    return { card: teamsCard(body), all };
  };
  let shown = lines.slice(0, maxSessions);
  let out = build(shown, lines.length - shown.length);
  // 28KB を超えるなら、セッションを後ろから減らす
  while (Buffer.byteLength(JSON.stringify(out.card)) > TEAMS_MAX_BYTES && shown.length) {
    shown = shown.slice(0, Math.max(0, shown.length - 5));
    out = build(shown, lines.length - shown.length);
  }
  const preview = [`**Work Log ${title(range)}**`, summary, ...out.all.map(([n, ls]) => `\n**${n}**\n${ls.map((l) => `- ${l}`).join('\n')}`)].join('\n');
  return { ...out.card, preview };
}

export function sessionEndTeams(s, { includeCost = false } = {}) {
  const parts = [tEsc(s.project), dur(s.activeMs), `${s.commits}コミット`];
  if (s.tool && s.tool !== 'claude') parts.push(toolLabel(s.tool));
  if (includeCost && s.cost) parts.push(`API 換算 $${s.cost.usd.toFixed(2)}`);
  const tasks = (s.tasks || []).map((t) => tLink(t.label, t.url));
  const body = [tb(`セッション終了: ${tEsc(s.displayTitle || s.title)}`, { weight: 'Bolder' }), tb(parts.join('・'), { spacing: 'Small' })];
  if (tasks.length) body.push(tb(`タスク: ${tasks.join(', ')}`, { spacing: 'Small' }));
  return teamsCard(body);
}

// Teams の Markdown をプレーンテキストに戻す(画面のプレビュー用)
export function plainFromTeams(text) {
  return text.replace(/\*\*/g, '').replace(/\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)');
}

// ---------------------------------------------------------------- Google Chat
// テキストメッセージ(*太字*、<URL|名前> のリンク)。Chat には記号を逃がす書き方がないので、
// 書式やメンション(<users/all> など)として解釈される記号は全角に置き換える。
// メッセージ全体は 32,000 バイトまで(Chat API の Message の説明)なので、収まるようにセッション一覧を削る
const GCHAT_MAX_BYTES = 30000;
const GCHAT_FULL = { '*': '＊', _: '＿', '~': '～', '`': '｀', '<': '＜', '>': '＞', '|': '｜' };
const gEsc = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/[*_~`<>|]/g, (c) => GCHAT_FULL[c]);
const gLink = (label, url) => (url && /^https?:\/\//.test(url) ? `<${String(url).replace(/[<>|\s]/g, encodeURIComponent)}|${gEsc(label)}>` : gEsc(label));

export function toGoogleChat(report, { includeCost = false, maxSessions = 20 } = {}) {
  const { totals, range } = report;
  const time = (iso) => new Intl.DateTimeFormat('ja-JP', { timeZone: range.timeZone, ...(range.period === 'week' ? { month: 'numeric', day: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const summary = report.sessions.length
    ? `作業 ${dur(totals.activeMs)}・${totals.sessions}セッション・${totals.commits}コミット${includeCost && totals.usd != null ? `・API 換算 $${totals.usd.toFixed(2)}` : ''}`
    : 'この期間の作業はありません。';
  const head = [`*Work Log ${title(range)}*\n${summary}`];
  if (report.projects.length) head.push(['*プロジェクト別*', ...report.projects.map((p) => `• ${gEsc(p.project)}  ${dur(p.activeMs)}(${p.sessions}セッション・${p.commits}コミット)`)].join('\n'));
  if (report.tasks.length) head.push(['*タスク*', ...report.tasks.map((t) => `• ${gLink(t.label, t.url)}${t.issue ? ` ${gEsc(t.issue.title)}(${gEsc(t.issue.stateLabel)})` : ''}  ${dur(t.activeMs)}`)].join('\n'));
  const lines = report.sessions.map((s) => `• ${time(s.start)} ${gEsc(s.title)} — ${gEsc(s.project)}・${dur(s.activeMs)}${s.commits ? `・${s.commits}コミット` : ''}${otherTool(s)}`);
  const build = (n) => {
    const parts = [...head];
    if (lines.length) parts.push(['*セッション*', ...lines.slice(0, n), ...(lines.length > n ? [`ほか ${lines.length - n} セッション`] : [])].join('\n'));
    return parts.join('\n\n');
  };
  let n = Math.min(maxSessions, lines.length);
  let text = build(n);
  // 32,000 バイトを超えるなら、セッションを後ろから減らす
  while (Buffer.byteLength(JSON.stringify({ text })) > GCHAT_MAX_BYTES && n > 0) text = build((n = Math.max(0, n - 5)));
  return { text, preview: text };
}

export function sessionEndGoogleChat(s, { includeCost = false } = {}) {
  const parts = [gEsc(s.project), dur(s.activeMs), `${s.commits}コミット`];
  if (s.tool && s.tool !== 'claude') parts.push(toolLabel(s.tool));
  if (includeCost && s.cost) parts.push(`API 換算 $${s.cost.usd.toFixed(2)}`);
  const tasks = (s.tasks || []).map((t) => gLink(t.label, t.url));
  return { text: [`*セッション終了: ${gEsc(s.displayTitle || s.title)}*`, parts.join('・'), ...(tasks.length ? [`タスク: ${tasks.join(', ')}`] : [])].join('\n') };
}

// Google Chat の書式をプレーンテキストに戻す(画面のプレビュー用)
export function plainFromGoogleChat(text) {
  return text.replace(/\*/g, '').replace(/<([^|>]+)\|([^>]+)>/g, '$2 ($1)');
}

// ---------------------------------------------------------------- 共通(テキスト系の送り先)
// 見出し・要約・各セクションの行を作る。書式ごとの記号の逃がし方(esc)とリンクの書き方(link)だけ送り先に任せる
function reportParts(report, { includeCost = false, maxSessions = 20 } = {}, { esc: e, link }) {
  const { totals, range } = report;
  const time = (iso) => new Intl.DateTimeFormat('ja-JP', { timeZone: range.timeZone, ...(range.period === 'week' ? { month: 'numeric', day: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const summary = report.sessions.length
    ? `作業 ${dur(totals.activeMs)}・${totals.sessions}セッション・${totals.commits}コミット${includeCost && totals.usd != null ? `・API 換算 $${totals.usd.toFixed(2)}` : ''}`
    : 'この期間の作業はありません。';
  const sections = [];
  if (report.projects.length) sections.push(['プロジェクト別', report.projects.map((p) => `${e(p.project)}  ${dur(p.activeMs)}(${p.sessions}セッション・${p.commits}コミット)`)]);
  if (report.tasks.length) sections.push(['タスク', report.tasks.map((t) => `${link(t.label, t.url)}${t.issue ? ` ${e(t.issue.title)}(${e(t.issue.stateLabel)})` : ''}  ${dur(t.activeMs)}`)]);
  const lines = report.sessions.map((s) => `${time(s.start)} ${e(s.title)} — ${e(s.project)}・${dur(s.activeMs)}${s.commits ? `・${s.commits}コミット` : ''}${otherTool(s)}`);
  return { heading: `Work Log ${title(range)}`, summary, sections, lines, maxSessions: Math.min(maxSessions, lines.length) };
}

// セッション一覧を n 件までにしたセクションを足す(n を超えた分は件数だけ書く)
const withSessions = (sections, lines, n) => (lines.length ? [...sections, ['セッション', [...lines.slice(0, n), ...(lines.length > n ? [`ほか ${lines.length - n} セッション`] : [])]]] : sections);

// 本文が上限に収まるまで、セッションを後ろから5件ずつ減らす
function fitSessions(p, render, fits) {
  let n = p.maxSessions;
  let out = render(withSessions(p.sections, p.lines, n));
  while (!fits(out) && n > 0) out = render(withSessions(p.sections, p.lines, (n = Math.max(0, n - 5))));
  return out;
}

const chars = (s) => [...s].length;
const FOOTER = 'ローカルの AI コーディングツールのセッションログから Work Log で作成';

// 全角にして書式やメンションとして解釈されないようにする(送り先ごとの対応表を渡す)
const fullwidth = (map) => {
  const re = new RegExp(`[${Object.keys(map).map((c) => `\\${c}`).join('')}]`, 'g');
  return (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(re, (c) => map[c]);
};
// http(s) の URL だけを通し、bad に当たる文字は %xx にする
const safeUrl = (url, bad) => (url && /^https?:\/\//.test(url) ? String(url).replace(bad, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`) : null);

// ---------------------------------------------------------------- Chatwork
// Chatwork 記法: [info][title]…[/title]…[/info]、[hr]。リンクは URL をそのまま書けば自動でリンクになる。
// [To:123] [toall] [info] などの記法は '[' で始まるので、利用者の文字列の [ ] は全角にして記法として働かせない。
// 本文の上限は API 定義(chatwork/api の RAML)で 65535 文字。余裕を見て 30000 文字に収める
const CW_MAX = 30000;
const cwEsc = fullwidth({ '[': '［', ']': '］' });
const cwLink = (label, url) => {
  const u = safeUrl(url, /[[\]\s]/g);
  return u ? `${cwEsc(label)} ${u}` : cwEsc(label);
};

export function toChatwork(report, { includeCost = false, maxSessions = 20 } = {}) {
  const p = reportParts(report, { includeCost, maxSessions }, { esc: cwEsc, link: cwLink });
  const render = (sections) => {
    const body = [p.summary, ...sections.map(([name, ls]) => `[hr]\n${name}\n${ls.map((l) => `・${l}`).join('\n')}`), `[hr]\n${FOOTER}`].join('\n');
    return `[info][title]${p.heading}[/title]${body}[/info]`;
  };
  const body = fitSessions(p, render, (t) => chars(t) <= CW_MAX);
  return { body, preview: body };
}

export function sessionEndChatwork(s, { includeCost = false } = {}) {
  const parts = [cwEsc(s.project), dur(s.activeMs), `${s.commits}コミット`];
  if (s.tool && s.tool !== 'claude') parts.push(toolLabel(s.tool));
  if (includeCost && s.cost) parts.push(`API 換算 $${s.cost.usd.toFixed(2)}`);
  const tasks = (s.tasks || []).map((t) => cwLink(t.label, t.url));
  return { body: `[info][title]セッション終了: ${cwEsc(s.displayTitle || s.title)}[/title]${parts.join('・')}${tasks.length ? `\nタスク: ${tasks.join(', ')}` : ''}[/info]` };
}

// Chatwork 記法をプレーンテキストに戻す(画面のプレビュー用)
export function plainFromChatwork(text) {
  return text.replace(/\[title\]/g, '').replace(/\[\/title\]/g, '\n').replace(/\[hr\]\n?/g, '────────\n').replace(/\[\/?info\]/g, '').trim();
}

// ---------------------------------------------------------------- Mattermost
// Markdown(見出し・リスト・リンク)。記号は \ で逃がし、@channel / @all / @here / @ユーザー は全角の ＠ にしてメンションにしない。
// 1投稿の上限は 16383 文字(古いサーバーの上限。新しいサーバーは 262144 文字まで)
const MM_MAX = 16383;
const mmEsc = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/@/g, '＠').replace(/([\\`*_~[\]<>|#])/g, '\\$1');
const mmLink = (label, url) => {
  const u = safeUrl(url, /[()\s<>]/g);
  return u ? `[${mmEsc(label)}](${u})` : mmEsc(label);
};

export function toMattermost(report, { includeCost = false, maxSessions = 20 } = {}) {
  const p = reportParts(report, { includeCost, maxSessions }, { esc: mmEsc, link: mmLink });
  const render = (sections) => [`### ${p.heading}`, p.summary, ...sections.map(([name, ls]) => `#### ${name}\n${ls.map((l) => `- ${l}`).join('\n')}`), `*${FOOTER}*`].join('\n\n');
  const text = fitSessions(p, render, (t) => chars(t) <= MM_MAX);
  return { text, preview: text };
}

export function sessionEndMattermost(s, { includeCost = false } = {}) {
  const parts = [mmEsc(s.project), dur(s.activeMs), `${s.commits}コミット`];
  if (s.tool && s.tool !== 'claude') parts.push(toolLabel(s.tool));
  if (includeCost && s.cost) parts.push(`API 換算 $${s.cost.usd.toFixed(2)}`);
  const tasks = (s.tasks || []).map((t) => mmLink(t.label, t.url));
  return { text: [`**セッション終了: ${mmEsc(s.displayTitle || s.title)}**`, parts.join('・'), ...(tasks.length ? [`タスク: ${tasks.join(', ')}`] : [])].join('\n') };
}

// Mattermost の Markdown をプレーンテキストに戻す(画面のプレビュー用)
export function plainFromMattermost(text) {
  return text.replace(/^#{1,6} /gm, '').replace(/\*\*/g, '').replace(/^\*(.*)\*$/gm, '$1').replace(/\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)').replace(/\\([\\`*_~[\]<>|#])/g, '$1');
}

// ---------------------------------------------------------------- Rocket.Chat
// Rocket.Chat の Markdown(*太字*、[名前](URL))。逃がす書き方が確かでないので、書式やメンション・チャンネル参照(@all / #room)になる記号は全角にする。
// 1メッセージの上限は設定 Message_MaxAllowedSize の初期値 5000 文字
const RC_MAX = 5000;
const rcEsc = fullwidth({ '*': '＊', _: '＿', '~': '～', '`': '｀', '[': '［', ']': '］', '@': '＠', '#': '＃', '<': '＜', '>': '＞' });
const rcLink = (label, url) => {
  const u = safeUrl(url, /[()\s<>]/g);
  return u ? `[${rcEsc(label)}](${u})` : rcEsc(label);
};

export function toRocketChat(report, { includeCost = false, maxSessions = 20 } = {}) {
  const p = reportParts(report, { includeCost, maxSessions }, { esc: rcEsc, link: rcLink });
  const render = (sections) => [`*${p.heading}*\n${p.summary}`, ...sections.map(([name, ls]) => `*${name}*\n${ls.map((l) => `• ${l}`).join('\n')}`)].join('\n\n');
  const text = fitSessions(p, render, (t) => chars(t) <= RC_MAX);
  return { text, preview: text };
}

export function sessionEndRocketChat(s, { includeCost = false } = {}) {
  const parts = [rcEsc(s.project), dur(s.activeMs), `${s.commits}コミット`];
  if (s.tool && s.tool !== 'claude') parts.push(toolLabel(s.tool));
  if (includeCost && s.cost) parts.push(`API 換算 $${s.cost.usd.toFixed(2)}`);
  const tasks = (s.tasks || []).map((t) => rcLink(t.label, t.url));
  return { text: [`*セッション終了: ${rcEsc(s.displayTitle || s.title)}*`, parts.join('・'), ...(tasks.length ? [`タスク: ${tasks.join(', ')}`] : [])].join('\n') };
}

// Rocket.Chat の Markdown をプレーンテキストに戻す(画面のプレビュー用)
export function plainFromRocketChat(text) {
  return text.replace(/\*/g, '').replace(/\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)');
}

// ---------------------------------------------------------------- LINE WORKS
// プレーンテキストだけ。テキストメッセージは 2000 文字までなので、章ごとに詰めて複数のメッセージに分ける
// (5通に収まらないときはセッションを減らす)。URL は貼れば自動でリンクになる
const LW_MAX = 1900;
const LW_MESSAGES = 5;
const plainEsc = (s) => String(s ?? '').replace(/\r?\n/g, ' ');
const plainLink = (label, url) => (url && /^https?:\/\//.test(url) ? `${plainEsc(label)} (${String(url).replace(/\s/g, encodeURIComponent)})` : plainEsc(label));

// ブロック(空行で区切る塊)を上限以内のメッセージに詰める。1つで収まらないブロックは行で分ける
function packBlocks(blocks, max) {
  const out = [];
  let cur = '';
  const push = (b, sep) => {
    if (cur && chars(`${cur}${sep}${b}`) <= max) cur += `${sep}${b}`;
    else {
      if (cur) out.push(cur);
      cur = b;
    }
  };
  for (const b of blocks) {
    if (chars(b) <= max) push(b, '\n\n');
    else for (const l of b.split('\n')) push([...l].slice(0, max).join(''), '\n');
  }
  if (cur) out.push(cur);
  return out;
}

export function toLineWorks(report, { includeCost = false, maxSessions = 20 } = {}) {
  const p = reportParts(report, { includeCost, maxSessions }, { esc: plainEsc, link: plainLink });
  const render = (sections) => packBlocks([`${p.heading}\n${p.summary}`, ...sections.map(([name, ls]) => `■ ${name}\n${ls.map((l) => `・${l}`).join('\n')}`)], LW_MAX);
  const messages = fitSessions(p, render, (m) => m.length <= LW_MESSAGES);
  return { messages, preview: messages.join('\n\n') };
}

export function sessionEndLineWorks(s, { includeCost = false } = {}) {
  const parts = [plainEsc(s.project), dur(s.activeMs), `${s.commits}コミット`];
  if (s.tool && s.tool !== 'claude') parts.push(toolLabel(s.tool));
  if (includeCost && s.cost) parts.push(`API 換算 $${s.cost.usd.toFixed(2)}`);
  const tasks = (s.tasks || []).map((t) => plainLink(t.label, t.url));
  const text = [`セッション終了: ${plainEsc(s.displayTitle || s.title)}`, parts.join('・'), ...(tasks.length ? [`タスク: ${tasks.join(', ')}`] : [])].join('\n');
  return { messages: [[...text].slice(0, LW_MAX).join('')] };
}

// LINE WORKS はプレーンテキストなので、そのまま使う
export const plainFromLineWorks = (text) => text;

// ---------------------------------------------------------------- 汎用 Webhook(Zapier / n8n / Make など)
// JSON をそのまま POST する。report には buildReport の結果(秘匿情報はマスキング済み)を渡す。
// text は人が読むための要約(プレーンテキスト)。費用は includeCost のときだけ入れる
export function toWebhook(report, { includeCost = false, maxSessions = 20 } = {}) {
  const { range, totals } = report;
  const p = reportParts(report, { includeCost, maxSessions }, { esc: plainEsc, link: plainLink });
  const text = [p.heading, p.summary, ...withSessions(p.sections, p.lines, p.maxSessions).map(([name, ls]) => `\n■ ${name}\n${ls.map((l) => `・${l}`).join('\n')}`)].join('\n');
  const payload = {
    type: 'report',
    version: 1,
    period: range.period,
    range: { start: new Date(range.from).toISOString(), end: new Date(range.to).toISOString(), startDate: range.start, timeZone: range.timeZone },
    totals: { activeMs: totals.activeMs, sessions: totals.sessions, commits: totals.commits, ...(includeCost && totals.usd != null ? { usd: totals.usd } : {}) },
    projects: report.projects.map((x) => ({ project: x.project, activeMs: x.activeMs, sessions: x.sessions, commits: x.commits })),
    tasks: report.tasks.map((t) => ({ id: t.id, label: t.label, url: t.url || null, activeMs: t.activeMs, ...(t.issue ? { issue: { title: t.issue.title, state: t.issue.stateLabel } } : {}) })),
    sessions: report.sessions.map((s) => ({ id: s.id, title: s.title, project: s.project, tool: s.tool, start: s.start, activeMs: s.activeMs, commits: s.commits, status: s.status })),
    text,
  };
  return { ...payload, preview: JSON.stringify(payload, null, 2) };
}

export function sessionEndWebhook(s, { includeCost = false } = {}) {
  return {
    type: 'session_end',
    version: 1,
    session: {
      id: s.id, title: s.displayTitle || s.title, project: s.project, tool: s.tool || 'claude', start: s.start, end: s.end, activeMs: s.activeMs, commits: s.commits,
      tasks: (s.tasks || []).map((t) => ({ id: t.id || null, label: t.label, url: t.url || null })),
      ...(includeCost && s.cost ? { usd: s.cost.usd } : {}),
    },
  };
}

// 汎用 Webhook のプレビューは整形した JSON なので、そのまま使う
export const plainFromWebhook = (text) => text;
