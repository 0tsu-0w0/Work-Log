// 日報・週報: 期間内の作業(時間・セッション・コミット・プロジェクト・タスク・コスト)をまとめ、
// Slack の mrkdwn とターミナル向けのプレーンテキストで書き出す。
// 時間は期間に入る部分だけを数え、コミットは時刻が期間内のものを数える。

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
  const tool = (t) => (t === 'codex' ? 'Codex' : 'Claude Code');
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
    const lines = shown.map((s) => `• ${time(s.start)} ${esc(s.title)} — ${esc(s.project)}・${dur(s.activeMs)}${s.commits ? `・${s.commits}コミット` : ''}${s.tool === 'codex' ? `(${tool(s.tool)})` : ''}`);
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
  if (s.tool === 'codex') parts.push('Codex');
  if (includeCost && s.cost) parts.push(`API 換算 $${s.cost.usd.toFixed(2)}`);
  const tasks = (s.tasks || []).map((t) => (t.url ? `<${t.url.replace(/[<>|]/g, encodeURIComponent)}|${esc(t.label)}>` : esc(t.label)));
  const text = `セッション終了: *${esc(s.displayTitle || s.title)}*\n${parts.join('・')}${tasks.length ? `\nタスク: ${tasks.join(', ')}` : ''}`;
  return { text: `セッション終了: ${s.displayTitle || s.title}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}
