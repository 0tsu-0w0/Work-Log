import { renderCosts } from './costs.js';
import { renderTasks, taskLink, issueState, notePosted, setToolLabels } from './tasks.js';

const $ = (id) => document.getElementById(id);
const HOUR_PX = 48;
const MIN_BLOCK_PX = 14;
const DAY_NAMES = ['月', '火', '水', '木', '金', '土', '日'];
// ツールの表示名(サーバーの取り込み元の一覧から上書きする)
let TOOL_LABEL = { claude: 'Claude Code', codex: 'Codex' };
const STATUS_LABEL = { working: '作業中', waiting: '入力待ち', done: '完了' };
const SOURCE_LABEL = { startup: '新規起動', resume: '再開', clear: '/clear 後', compact: 'コンパクト後', fork: 'フォーク' };
const END_LABEL = { clear: '/clear', resume: '別セッションを再開', logout: 'ログアウト', prompt_input_exit: '終了操作', other: 'その他' };

const state = {
  weekStart: startOfWeek(new Date()),
  project: '',
  tag: '',
  tool: '',
  q: '',
  selectedId: null,
  view: 'calendar', // calendar | cost | tasks
  costRange: 'week', // week | month
  monthStart: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  sessions: [],
  config: null,
};

// ---- ユーティリティ ----
function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // 月曜始まり
  return x;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function fmtTime(d) {
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(d) {
  return d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
}
function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}分`;
  return `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}`;
}
function fmtUsd(v) {
  return v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;
}
function fmtNum(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}
// プロジェクト名から安定した色を作る
function projectColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `hsl(${h % 360} 58% 46%)`;
}
async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

// ---- データ取得 ----
async function loadWeek() {
  const params = new URLSearchParams({
    from: state.weekStart.toISOString(),
    to: addDays(state.weekStart, 7).toISOString(),
  });
  if (state.project) params.set('project', state.project);
  if (state.tag) params.set('tag', state.tag);
  if (state.tool) params.set('tool', state.tool);
  const data = await api(`/api/sessions?${params}`);
  state.sessions = data.sessions;
  // ツールが1種類しか無いときはツールの絞り込みを出さない
  $('tool').hidden = data.tools.length < 2 && !state.tool;
  $('tool').innerHTML = '<option value="">すべてのツール</option>' + data.tools.map((t) => `<option value="${esc(t)}" ${t === state.tool ? 'selected' : ''}>${esc(TOOL_LABEL[t] || t)}</option>`).join('');
  fillSelect($('project'), data.projects, state.project, 'すべてのプロジェクト');
  fillSelect($('tag'), data.tags, state.tag, 'すべてのタグ');
  renderCalendar();
  if (state.selectedId) await showDetail(state.selectedId, { quiet: true });
  else renderWeekStats();
}

function fillSelect(sel, values, current, label) {
  sel.innerHTML = `<option value="">${label}</option>` + values.map((v) => `<option ${v === current ? 'selected' : ''}>${esc(v)}</option>`).join('');
}

// ---- カレンダー描画 ----
function renderCalendar() {
  const today = new Date();
  const days = [...Array(7)].map((_, i) => addDays(state.weekStart, i));
  $('range').textContent = `${state.weekStart.getFullYear()}年 ${fmtDate(days[0])} 〜 ${fmtDate(days[6])}`;
  $('cal-head').innerHTML =
    '<div></div>' +
    days.map((d, i) => `<div class="${sameDay(d, today) ? 'today' : ''}">${DAY_NAMES[i]} ${d.getDate()}<small>${fmtDuration(dayTotal(d))}</small></div>`).join('');
  $('hours').innerHTML = [...Array(24)].map((_, h) => `<div>${h ? `${h}:00` : ''}</div>`).join('');

  const daysEl = $('days');
  daysEl.innerHTML = days.map((d) => `<div class="day ${sameDay(d, today) ? 'today' : ''}"></div>`).join('');
  const cols = daysEl.children;

  days.forEach((day, i) => {
    const pieces = piecesForDay(day);
    layoutLanes(pieces);
    for (const p of pieces) cols[i].appendChild(blockEl(p));
    if (sameDay(day, today)) {
      const line = document.createElement('div');
      line.className = 'now-line';
      line.style.top = `${minutesOfDay(today) * (HOUR_PX / 60)}px`;
      cols[i].appendChild(line);
    }
  });
}

function minutesOfDay(d) {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

// セッションのアクティビティ区間を、その日の範囲に切り出したもの
function piecesForDay(day) {
  const dayStart = day.getTime();
  const dayEnd = addDays(day, 1).getTime();
  const pieces = [];
  const now = Date.now();
  for (const s of state.sessions) {
    s.segments.forEach((seg, i) => {
      // 作業中のセッションは、最後のブロックを現在時刻まで伸ばす
      const segEnd = s.status === 'working' && i === s.segments.length - 1 ? Math.max(Date.parse(seg.end), now) : Date.parse(seg.end);
      const a = Math.max(Date.parse(seg.start), dayStart);
      const b = Math.min(Math.max(segEnd, Date.parse(seg.start) + 60000), dayEnd);
      if (b <= a) return;
      const top = ((a - dayStart) / 3600000) * HOUR_PX;
      const height = Math.max(((b - a) / 3600000) * HOUR_PX, MIN_BLOCK_PX);
      pieces.push({ s, a, b, top, height, bottom: top + height });
    });
  }
  return pieces.sort((x, y) => x.top - y.top || y.height - x.height);
}

function dayTotal(day) {
  return piecesForDay(day).reduce((sum, p) => sum + (p.b - p.a), 0);
}

// 重なるブロックを横に並べる(重なりのまとまりごとに列数を決める)
function layoutLanes(pieces) {
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = [];
    for (const p of cluster) {
      let lane = lanes.findIndex((end) => end <= p.top);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = p.bottom;
      p.lane = lane;
    }
    for (const p of cluster) p.lanes = lanes.length;
    cluster = [];
  };
  for (const p of pieces) {
    if (p.top >= clusterEnd) flush();
    cluster.push(p);
    clusterEnd = Math.max(clusterEnd, p.bottom);
  }
  flush();
}

function blockEl(p) {
  const { s } = p;
  const el = document.createElement('div');
  el.className = `block ${s.status} ${s.tool && s.tool !== 'claude' ? 'other-tool' : ''} ${s.id === state.selectedId ? 'selected' : ''}`;
  el.dataset.id = s.id;
  el.style.top = `${p.top}px`;
  el.style.height = `${p.height}px`;
  el.style.left = `calc(${(p.lane / p.lanes) * 100}% + 2px)`;
  el.style.width = `calc(${100 / p.lanes}% - 4px)`;
  el.style.background = projectColor(s.project);
  el.title = `${s.displayTitle}\n${s.project} · ${fmtTime(new Date(p.a))}〜${fmtTime(new Date(p.b))} · ${STATUS_LABEL[s.status]}`;
  el.innerHTML = `<div class="t">${esc(s.displayTitle)}</div>` + (p.height > 30 ? `<div class="m">${s.tool && s.tool !== 'claude' ? `${esc(TOOL_LABEL[s.tool] || s.tool)} · ` : ''}${esc(s.project)} · ${fmtTime(new Date(p.a))}</div>` : '');
  el.addEventListener('click', () => showDetail(s.id));
  return el;
}

// ---- 週の集計(未選択時) ----
function renderWeekStats() {
  const byProject = new Map();
  let total = 0;
  for (const s of state.sessions) {
    const ms = weekActiveMs(s);
    total += ms;
    byProject.set(s.project, (byProject.get(s.project) || 0) + ms);
  }
  const rows = [...byProject.entries()].sort((a, b) => b[1] - a[1]);
  const max = Math.max(...rows.map((r) => r[1]), 1);
  $('detail').innerHTML = `
    <div class="stats">
      <h3>今週の作業 ${fmtDuration(total)} · ${state.sessions.length}セッション · ${state.sessions.reduce((n, s) => n + s.commits, 0)}コミット</h3>
      <p class="small">この週に動いたセッションの API 換算コスト: ${fmtUsd(state.sessions.reduce((n, s) => n + s.cost.usd, 0))}(週をまたぐセッションは全体の額)</p>
      ${rows.map(([name, ms]) => `
        <div class="bar-row">
          <span class="name"><span class="proj-dot" style="background:${projectColor(name)}"></span>${esc(name)}</span>
          <div class="bar" style="width:${(ms / max) * 100}%;background:${projectColor(name)}"></div>
          <span class="v">${fmtDuration(ms)}</span>
        </div>`).join('') || '<p class="hint">この週のセッションはありません。</p>'}
    </div>
    <p class="hint">ブロックを選ぶと、セッションの詳細を表示します。</p>
    ${sendButtons()}
    ${calendarTools()}`;
  document.querySelectorAll('.slack-send button').forEach((b) => (b.onclick = () => sendReport(b.dataset.target, b.dataset.period, b)));
  document.querySelectorAll('.sync-send button').forEach((b) => (b.onclick = () => syncWeek(b.dataset.sync, b)));
}

function weekActiveMs(s) {
  const a0 = state.weekStart.getTime();
  const b0 = addDays(state.weekStart, 7).getTime();
  return s.segments.reduce((sum, g) => sum + Math.max(0, Math.min(Date.parse(g.end), b0) - Math.max(Date.parse(g.start), a0)), 0);
}

// ---- 詳細パネル ----
async function showDetail(id, { quiet = false } = {}) {
  state.selectedId = id;
  document.querySelectorAll('.block').forEach((b) => b.classList.toggle('selected', b.dataset.id === id));
  let s;
  try {
    s = await api(`/api/sessions/${encodeURIComponent(id)}`);
  } catch (err) {
    if (quiet) {
      state.selectedId = null;
      return renderWeekStats();
    }
    $('detail').innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  const start = new Date(s.start);
  const end = new Date(s.end);
  const tools = Object.entries(s.toolCalls).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
  const llm = state.config?.llm;
  $('detail').innerHTML = `
    <button id="close" title="閉じる">← 週の集計</button>
    <h2>${esc(s.displayTitle)}</h2>
    <div>
      <span class="badge ${s.status}">${STATUS_LABEL[s.status]}</span>
      <span class="badge tool">${esc(TOOL_LABEL[s.tool] || s.tool)}</span>
      <span class="badge type tag" data-tag="${esc(s.workType)}">${esc(s.workType)}</span>
      ${s.components.map((c) => `<span class="badge tag" data-tag="${esc(c)}">${esc(c)}</span>`).join('')}
    </div>
    <p class="meta"><span class="proj-dot" style="background:${projectColor(s.project)}"></span>${esc(s.project)}${s.gitBranch ? ` · ${esc(s.gitBranch)}` : ''}</p>
    <p class="meta">${fmtDate(start)} ${fmtTime(start)} 〜 ${s.status === 'working' ? '現在' : (sameDay(start, end) ? '' : fmtDate(end) + ' ') + fmtTime(end)}(作業 ${fmtDuration(s.activeMs)})</p>
    <div class="kv">
      <div><b>${s.git?.available ? s.git.totals.commits : s.commits}</b><span>コミット</span>${s.git?.available && s.git.totals.commits ? `<span class="diffstat"><ins>+${s.git.totals.insertions}</ins> <del>−${s.git.totals.deletions}</del></span>` : ''}</div>
      <div><b>${s.changedFiles.length}</b><span>変更ファイル</span></div>
      <div><b>${s.messageCount}</b><span>メッセージ</span></div>
    </div>
    <div class="section-title">要約
      <span class="small">${s.summarySource === 'llm' ? `LLM${s.summaryStale ? '(セッション更新あり)' : ''}` : '自動抽出'}</span>
      ${llm ? `<button id="summarize">${s.summarySource === 'llm' ? '再要約' : 'LLMで要約'}</button>` : ''}
    </div>
    <div class="summary" id="summary">${esc(s.summary)}</div>
    ${llm ? '' : '<p class="small">ANTHROPIC_API_KEY を設定して起動すると、LLMで要約できます。</p>'}
    <div class="section-title">タスク</div>
    <div class="task-chips">${s.tasks.map((t) => `<span class="chip" title="${esc(t.issue?.title || '')}">${taskLink(t)}${t.issue ? ` ${issueState(t.issue)}` : ''}<button class="rm" data-id="${esc(t.id)}" title="このセッションから外す" aria-label="${esc(t.label)} を外す">×</button></span>`).join('') || '<span class="small">見つかっていません</span>'}</div>
    <form class="task-add" id="task-add"><input name="task" placeholder="ABC-123、#45、課題のURL" aria-label="紐付けるタスク"><button>紐付け</button></form>
    ${renderGit(s)}
    ${s.changedFiles.length ? `<div class="section-title">変更ファイル</div><ul class="files">${s.changedFiles.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
    ${s.firstPrompt ? `<div class="section-title">最初の依頼</div><div class="prompt">${esc(s.firstPrompt)}</div>` : ''}
    <div class="section-title">詳細</div>
    <p class="meta">ツール: ${esc(tools || 'なし')}</p>
    <p class="meta">トークン: 入力 ${fmtNum(s.tokens.input + s.tokens.cacheRead + s.tokens.cacheCreation)}(キャッシュ読込 ${fmtNum(s.tokens.cacheRead)})/ 出力 ${fmtNum(s.tokens.output)}</p>
    <p class="meta">モデル: ${esc(s.models.join(', ') || '-')}</p>
    <p class="meta">API 換算コスト: ${s.cost.usd === 0 && s.cost.unknownModels.length ? '単価不明(~/.work-log/pricing.json で設定)' : fmtUsd(s.cost.usd)}${s.cost.subagents ? `(サブエージェント ${s.cost.subagents}件 ${fmtUsd(s.cost.subagentUsd)} を含む)` : ''}${s.cost.estimatedOutputTokens ? ' · 一部見積もり' : ''}${s.cost.unknownModels.length ? ` · 単価不明: ${esc(s.cost.unknownModels.join(', '))}` : ''}</p>
    ${s.hook ? `<p class="meta">hooks: ${s.hook.source ? `開始 ${esc(SOURCE_LABEL[s.hook.source] || s.hook.source)} · ` : ''}${s.hook.endedAt ? `終了 ${fmtTime(new Date(s.hook.endedAt))}(${esc(END_LABEL[s.hook.endReason] || s.hook.endReason || '-')}) · ` : ''}最終イベント ${esc(s.hook.lastEvent)} ${fmtTime(new Date(s.hook.lastEventAt))}</p>` : ''}
    <p class="meta small">${esc(s.cwd || '')}<br>${esc(s.id)}</p>`;

  const postTasks = async (body) => {
    try {
      await api(`/api/sessions/${encodeURIComponent(id)}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      await refresh();
    } catch (err) {
      $('task-add').insertAdjacentHTML('afterend', `<p class="error">${esc(err.message)}</p>`);
    }
  };
  $('task-add').onsubmit = (e) => {
    e.preventDefault();
    const v = e.target.task.value.trim();
    if (v) postTasks({ add: [v] });
  };
  document.querySelectorAll('#detail .chip .rm').forEach((b) => (b.onclick = () => postTasks({ remove: [b.dataset.id] })));
  $('close').onclick = () => {
    state.selectedId = null;
    document.querySelectorAll('.block.selected').forEach((b) => b.classList.remove('selected'));
    renderWeekStats();
  };
  document.querySelectorAll('#detail .badge.tag').forEach((b) => {
    b.onclick = () => {
      state.tag = b.dataset.tag;
      loadWeek();
    };
  });
  const btn = $('summarize');
  if (btn) {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = '要約中…';
      try {
        await api(`/api/sessions/${encodeURIComponent(id)}/summarize?force=${s.summarySource === 'llm' ? 1 : 0}`, { method: 'POST' });
        await loadWeek();
      } catch (err) {
        $('summary').insertAdjacentHTML('afterend', `<p class="error">${esc(err.message)}</p>`);
        btn.disabled = false;
        btn.textContent = 'LLMで要約';
      }
    };
  }
}

const GIT_REASON = { 'not-repo': 'Git リポジトリではありません', 'no-git': 'git コマンドが見つかりません', 'no-cwd': '作業ディレクトリが不明です', error: 'Git の読み取りに失敗しました' };

function renderGit(s) {
  const g = s.git;
  if (!g) return '';
  if (!g.available) {
    // ログ上のコミットだけでも見せる(別のマシンのログ、リポジトリ削除済みなど)
    if (!s.commitList.length) return `<div class="section-title">Git</div><p class="small">${esc(GIT_REASON[g.reason] || g.reason)}</p>`;
    return `<div class="section-title">コミット <span class="small">${esc(GIT_REASON[g.reason] || '')}・ログから抽出</span></div>
      <ul class="commits">${s.commitList.map((c) => `<li><code>${esc(c.hash)}</code> ${esc(c.subject)}</li>`).join('')}</ul>`;
  }
  const rows = g.commits.map((c) => {
    const hash = c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer"><code>${esc(c.short)}</code></a>` : `<code>${esc(c.short)}</code>`;
    const src = c.source === 'claude' ? '<span class="src claude" title="Claude が実行した git commit">Claude</span>' : '<span class="src time" title="セッション中に同じ作者が作成したコミット">同時間帯</span>';
    return `<li title="${esc(c.files.join('\n'))}">
      <div>${hash} ${src} ${esc(c.subject)}</div>
      <div class="small">${fmtTime(new Date(c.commitDate))} · ${esc(c.author)} · ${c.files.length}ファイル <ins>+${c.insertions}</ins> <del>−${c.deletions}</del></div>
    </li>`;
  });
  const missing = g.missing.map((c) => `<li class="gone" title="amend・rebase などで書き換えられたか、このマシンのリポジトリにありません"><div><code>${esc(c.hash)}</code> <span class="src">見つかりません</span> ${esc(c.subject)}</div></li>`);
  const repo = g.webBase ? `<a href="${esc(g.webBase)}" target="_blank" rel="noopener noreferrer">${esc(g.webBase.replace(/^https:\/\//, ''))}</a>` : esc(g.root);
  return `<div class="section-title">コミット <span class="small">${repo}</span></div>
    ${rows.length || missing.length ? `<ul class="commits">${rows.join('')}${missing.join('')}</ul>` : '<p class="small">このセッションの時間帯のコミットはありません。</p>'}`;
}

// ---- キーワード検索(全期間) ----
let searchTimer;
async function runSearch() {
  const box = $('search-results');
  const q = state.q.trim();
  if (!q) {
    box.hidden = true;
    return;
  }
  const params = new URLSearchParams({ q });
  if (state.project) params.set('project', state.project);
  if (state.tool) params.set('tool', state.tool);
  if (state.tag) params.set('tag', state.tag);
  const { sessions } = await api(`/api/sessions?${params}`);
  box.hidden = false;
  box.innerHTML = `<h3>「${esc(q)}」 ${sessions.length}件</h3>` + sessions.slice(0, 50).map((s) => `
    <div class="result" data-id="${esc(s.id)}" data-start="${esc(s.start)}">
      <div><span class="proj-dot" style="background:${projectColor(s.project)}"></span>${esc(s.displayTitle)}</div>
      <div class="d">${fmtDate(new Date(s.start))} ${fmtTime(new Date(s.start))} · ${esc(s.project)} · ${esc(s.workType)}</div>
    </div>`).join('');
  box.querySelectorAll('.result').forEach((el) => {
    el.onclick = async () => {
      state.weekStart = startOfWeek(new Date(el.dataset.start));
      state.selectedId = el.dataset.id;
      await loadWeek();
      const block = document.querySelector(`.block[data-id="${CSS.escape(el.dataset.id)}"]`);
      block?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
  });
}

// ---- イベント ----
// ---- コストビュー ----
let redrawCosts = null;

function costPeriod() {
  if (state.costRange === 'month') {
    const from = state.monthStart;
    const to = new Date(from.getFullYear(), from.getMonth() + 1, 1);
    const days = [];
    for (let d = new Date(from); d < to; d = addDays(d, 1)) days.push(d);
    return { from, to, days, label: `${from.getFullYear()}年${from.getMonth() + 1}月` };
  }
  const days = [...Array(7)].map((_, i) => addDays(state.weekStart, i));
  return { from: state.weekStart, to: addDays(state.weekStart, 7), days, label: null };
}

async function loadCosts() {
  const { from, to, days, label } = costPeriod();
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  if (state.project) params.set('project', state.project);
  if (state.tool) params.set('tool', state.tool);
  const data = await api(`/api/costs?${params}`);
  if (label) $('range').textContent = label;
  redrawCosts = renderCosts($('costs'), data, { days, onSession: (id) => showDetail(id) });
}

async function loadTasks() {
  const { from, to, label } = costPeriod();
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  if (state.project) params.set('project', state.project);
  if (state.tool) params.set('tool', state.tool);
  const { tasks } = await api(`/api/tasks?${params}`);
  if (label) $('range').textContent = label;
  renderTasks($('tasks'), tasks, { onSession: (id) => showDetail(id), onComment: commentOnIssue });
}

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// 画面の自動更新で描き直しても、送った結果の表示は残す
let slackSent = null;

const destInfo = (name) => (state.config?.destinations || []).find((d) => d.name === name) || {};
const DEST_LABEL = new Proxy({}, { get: (_, name) => destInfo(name).label || String(name) });

function sendButtons() {
  const all = state.config?.destinations || [];
  const dests = all.filter((d) => d.configured).map((d) => d.name);
  if (!dests.length) return `<p class="small">送り先(${esc(all.map((d) => d.label).join('・'))})の環境変数を設定すると、日報・週報を送れます(README の「送り先」を参照)。</p>`;
  return (
    dests
      .map((t) => `<div class="slack-send"><span class="small">${DEST_LABEL[t]}(${esc(state.config[t].destination)})に送る</span>
        <button data-target="${t}" data-period="day">今日の日報…</button><button data-target="${t}" data-period="week">この週の週報…</button></div>`)
      .join('') +
    (slackSent ? `<p class="small">${esc(DEST_LABEL[slackSent.target])}に${esc(slackSent.label)}を送りました${slackSent.url ? `: <a href="${esc(slackSent.url)}" target="_blank" rel="noopener noreferrer">開く</a>` : '。'}</p>` : '')
  );
}

// 日報・週報を Slack に送る。送る本文をそのまま見せ、確認してから送る
function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function sendReport(target, period, button) {
  const msg = (text, cls = 'small') => button.parentElement.insertAdjacentHTML('afterend', `<p class="${cls}">${esc(text)}</p>`);
  const date = period === 'week' ? localDate(state.weekStart) : localDate(new Date());
  const q = new URLSearchParams({ target, period, date, tz: TZ });
  let preview;
  try {
    preview = await api(`/api/report?${q}`);
  } catch (err) {
    return msg(err.message, 'error');
  }
  const dlg = $('comment-dialog');
  $('comment-title').textContent = `${DEST_LABEL[target]}(${preview.status.destination})に${period === 'week' ? '週報' : '日報'}を送ります`;
  $('comment-note').textContent = `次の内容が送られます(${DEST_LABEL[target]} では見出しが太字、タスクがリンクになります)。${destInfo(target).note || ''}${preview.status.includeCost ? 'API 換算コストを含みます。' : ''}`;
  $('comment-body').textContent = preview.previewText;
  dlg.showModal();
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'post') return;
    button.disabled = true;
    try {
      const r = await api('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, period, date, tz: TZ, hash: preview.hash }) });
      slackSent = { target, label: period === 'week' ? '週報' : '日報', url: r.url };
      if (!state.selectedId) renderWeekStats();
    } catch (err) {
      msg(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  };
}

// ---- カレンダー(.ics)の書き出しと、カレンダー・工数管理サービスへの記録 ----
let syncDone = null; // 画面の自動更新で描き直しても、記録した結果の表示は残す

const weekRange = () => ({ from: state.weekStart.toISOString(), to: addDays(state.weekStart, 7).toISOString() });

function calendarTools() {
  const q = new URLSearchParams({ ...weekRange(), tz: TZ });
  const ics = `/api/calendar.ics?${q}`;
  const all = state.config?.syncs || [];
  const on = all.filter((s) => s.configured);
  return `<div class="cal-export">
      <p class="small"><a href="${esc(ics)}" download>カレンダー(.ics)を書き出す</a>(この週の作業。秘匿情報は伏せます)</p>
      <p class="small export-links">表計算ソフト向け: <a href="${esc(`/api/export.csv?${q}`)}" download>CSV</a> ・ <a href="${esc(`/api/export.xlsx?${q}`)}" download>Excel(.xlsx)</a>(作業の区間ごとの時間・コミット・コスト)</p>
      ${on.map((s) => `<div class="sync-send"><span class="small">${esc(s.label)}(${esc(s.destination)})</span><button data-sync="${esc(s.name)}">この週を${esc(s.label)}に記録…</button></div>`).join('')}
      ${on.length ? '' : all.length ? `<p class="small">${esc(all.map((s) => s.label).join('・'))} の環境変数を設定すると、作業をカレンダーや工数管理サービスに記録できます。</p>` : ''}
      ${syncDone ? `<p class="small">${esc(syncDone)}</p>` : ''}
    </div>`;
}

// 終わったセッションを記録する。追加・更新・削除の一覧を見せ、確認してから送る
async function syncWeek(target, button) {
  const msg = (text, cls = 'small') => button.parentElement.insertAdjacentHTML('afterend', `<p class="${cls}">${esc(text)}</p>`);
  const range = { target, ...weekRange(), tz: TZ };
  let preview;
  try {
    preview = await api(`/api/sync?${new URLSearchParams(range)}`);
  } catch (err) {
    return msg(err.message, 'error');
  }
  const c = preview.counts;
  if (!c.create && !c.update && !c.delete) return msg(`${preview.label} に記録する変更はありません(記録済み ${c.unchanged}件)。`);
  const dlg = $('comment-dialog');
  const ok = dlg.querySelector('button[value="post"]');
  const okText = ok.textContent;
  ok.textContent = '記録する';
  $('comment-title').textContent = `${preview.label}(${preview.status.destination})にこの週の作業を記録します`;
  $('comment-note').textContent = `終わったセッションだけが対象です(${preview.status.mergeSegments ? 'セッションごとに1件' : '作業の区間ごとに1件'}、${preview.status.minMinutes}分未満は除く)。タイトルと説明の秘匿情報は伏せます。削除は Work Log が作った記録だけです。`;
  $('comment-body').textContent = preview.previewText;
  dlg.showModal();
  dlg.onclose = async () => {
    ok.textContent = okText;
    if (dlg.returnValue !== 'post') return;
    button.disabled = true;
    try {
      const r = await api('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...range, hash: preview.hash }) });
      syncDone = `${preview.label}に記録しました: 追加 ${r.created}件・更新 ${r.updated}件・削除 ${r.deleted}件`;
      if (!state.selectedId) renderWeekStats();
    } catch (err) {
      msg(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  };
}

// issue への作業記録の投稿。投稿する本文をそのまま見せ、確認してから送る
async function commentOnIssue(taskId, button) {
  const msg = (text, cls = 'small') => button.insertAdjacentHTML('afterend', `<p class="${cls}">${esc(text)}</p>`);
  let preview;
  try {
    preview = await api(`/api/tasks/comment?id=${encodeURIComponent(taskId)}&tz=${encodeURIComponent(TZ)}`);
  } catch (err) {
    return msg(err.message, 'error');
  }
  if (!preview.authenticated) return msg(`${preview.providerLabel} への投稿には認証情報が必要です(README の「課題管理サービス連携」を参照)。`, 'error');
  const dlg = $('comment-dialog');
  $('comment-title').textContent = `${preview.providerLabel} ${preview.target} にコメントを投稿します`;
  $('comment-note').textContent = '次の内容がそのまま投稿されます。この課題(ページ)を見られる人全員が読めます。';
  $('comment-body').textContent = preview.body;
  dlg.showModal();
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'post') return;
    button.disabled = true;
    try {
      const r = await api('/api/tasks/comment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: taskId, hash: preview.hash, tz: TZ }) });
      notePosted(taskId, r.url);
      await refresh();
    } catch (err) {
      msg(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  };
}

async function refresh() {
  await loadWeek();
  if (state.view === 'cost') await loadCosts();
  if (state.view === 'tasks') await loadTasks();
}

function setView(view) {
  state.view = view;
  $('calendar').hidden = view !== 'calendar';
  $('costs').hidden = view !== 'cost';
  $('tasks').hidden = view !== 'tasks';
  $('cost-range').hidden = view === 'calendar';
  $('tab-calendar').setAttribute('aria-selected', String(view === 'calendar'));
  $('tab-cost').setAttribute('aria-selected', String(view === 'cost'));
  $('tab-tasks').setAttribute('aria-selected', String(view === 'tasks'));
  refresh();
}

function shiftPeriod(dir) {
  if (state.view !== 'calendar' && state.costRange === 'month') {
    state.monthStart = new Date(state.monthStart.getFullYear(), state.monthStart.getMonth() + dir, 1);
    state.weekStart = startOfWeek(state.monthStart);
  } else {
    state.weekStart = addDays(state.weekStart, 7 * dir);
    state.monthStart = new Date(state.weekStart.getFullYear(), state.weekStart.getMonth(), 1);
  }
  refresh();
}

$('tab-calendar').onclick = () => setView('calendar');
$('tab-cost').onclick = () => setView('cost');
$('tab-tasks').onclick = () => setView('tasks');
document.querySelectorAll('#cost-range button').forEach((b) => {
  b.onclick = () => {
    state.costRange = b.dataset.range;
    document.querySelectorAll('#cost-range button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    refresh();
  };
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.view === 'cost' && redrawCosts?.(), 150);
});

$('prev').onclick = () => shiftPeriod(-1);
$('next').onclick = () => shiftPeriod(1);
$('today').onclick = () => {
  state.weekStart = startOfWeek(new Date());
  state.monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  refresh();
};
$('project').onchange = (e) => { state.project = e.target.value; refresh(); runSearch(); };
$('tool').onchange = (e) => { state.tool = e.target.value; refresh(); runSearch(); };
$('tag').onchange = (e) => { state.tag = e.target.value; loadWeek(); runSearch(); };
$('q').oninput = (e) => {
  state.q = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 200);
};

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onopen = () => $('live').classList.add('on');
  es.onerror = () => $('live').classList.remove('on');
  const onChange = () => { refresh(); if (state.q) runSearch(); };
  es.addEventListener('update', onChange);
  es.addEventListener('tick', onChange);
}

function renderHooksBadge() {
  const el = $('hooks');
  const h = state.config.hooks;
  const on = h.installed.length > 0;
  el.className = `hooks-badge ${on ? 'on' : ''}`;
  el.textContent = on ? 'hooks連携中' : 'hooks未設定';
  el.title = on
    ? `登録イベント: ${h.installed.join(', ')}\n最終受信: ${h.lastEventAt ? new Date(h.lastEventAt).toLocaleString('ja-JP') : 'まだありません'}`
    : 'node src/cli.js hooks install を実行すると、作業中/入力待ちの状態をリアルタイムに記録します';
}

(async () => {
  state.config = await api('/api/config');
  TOOL_LABEL = { ...TOOL_LABEL, ...(state.config.toolLabels || {}) };
  setToolLabels(TOOL_LABEL);
  renderHooksBadge();
  await loadWeek();
  // 8時付近を初期表示位置にする
  $('cal-body').scrollTop = HOUR_PX * 8;
  $('calendar').scrollTop = HOUR_PX * 8; // 狭い画面では calendar 自体がスクロールする
  connectEvents();
})();
