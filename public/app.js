const $ = (id) => document.getElementById(id);
const HOUR_PX = 48;
const MIN_BLOCK_PX = 14;
const DAY_NAMES = ['月', '火', '水', '木', '金', '土', '日'];

const state = {
  weekStart: startOfWeek(new Date()),
  project: '',
  tag: '',
  q: '',
  selectedId: null,
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
  const data = await api(`/api/sessions?${params}`);
  state.sessions = data.sessions;
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
  for (const s of state.sessions) {
    for (const seg of s.segments) {
      const a = Math.max(Date.parse(seg.start), dayStart);
      const b = Math.min(Math.max(Date.parse(seg.end), Date.parse(seg.start) + 60000), dayEnd);
      if (b <= a) continue;
      const top = ((a - dayStart) / 3600000) * HOUR_PX;
      const height = Math.max(((b - a) / 3600000) * HOUR_PX, MIN_BLOCK_PX);
      pieces.push({ s, a, b, top, height, bottom: top + height });
    }
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
  el.className = `block ${s.status === 'active' ? 'active' : ''} ${s.id === state.selectedId ? 'selected' : ''}`;
  el.dataset.id = s.id;
  el.style.top = `${p.top}px`;
  el.style.height = `${p.height}px`;
  el.style.left = `calc(${(p.lane / p.lanes) * 100}% + 2px)`;
  el.style.width = `calc(${100 / p.lanes}% - 4px)`;
  el.style.background = projectColor(s.project);
  el.title = `${s.displayTitle}\n${s.project} · ${fmtTime(new Date(p.a))}〜${fmtTime(new Date(p.b))}`;
  el.innerHTML = `<div class="t">${esc(s.displayTitle)}</div>` + (p.height > 30 ? `<div class="m">${esc(s.project)} · ${fmtTime(new Date(p.a))}</div>` : '');
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
      <h3>今週の作業 ${fmtDuration(total)} · ${state.sessions.length}セッション</h3>
      ${rows.map(([name, ms]) => `
        <div class="bar-row">
          <span class="name"><span class="proj-dot" style="background:${projectColor(name)}"></span>${esc(name)}</span>
          <div class="bar" style="width:${(ms / max) * 100}%;background:${projectColor(name)}"></div>
          <span class="v">${fmtDuration(ms)}</span>
        </div>`).join('') || '<p class="hint">この週のセッションはありません。</p>'}
    </div>
    <p class="hint">ブロックを選ぶと、セッションの詳細を表示します。</p>`;
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
      <span class="badge ${s.status}">${s.status === 'active' ? '進行中' : '完了'}</span>
      <span class="badge type tag" data-tag="${esc(s.workType)}">${esc(s.workType)}</span>
      ${s.components.map((c) => `<span class="badge tag" data-tag="${esc(c)}">${esc(c)}</span>`).join('')}
    </div>
    <p class="meta"><span class="proj-dot" style="background:${projectColor(s.project)}"></span>${esc(s.project)}${s.gitBranch ? ` · ${esc(s.gitBranch)}` : ''}</p>
    <p class="meta">${fmtDate(start)} ${fmtTime(start)} 〜 ${sameDay(start, end) ? '' : fmtDate(end) + ' '}${fmtTime(end)}(作業 ${fmtDuration(s.activeMs)})</p>
    <div class="kv">
      <div><b>${s.commits}</b><span>コミット</span></div>
      <div><b>${s.changedFiles.length}</b><span>変更ファイル</span></div>
      <div><b>${s.messageCount}</b><span>メッセージ</span></div>
    </div>
    <div class="section-title">要約
      <span class="small">${s.summarySource === 'llm' ? `LLM${s.summaryStale ? '(セッション更新あり)' : ''}` : '自動抽出'}</span>
      ${llm ? `<button id="summarize">${s.summarySource === 'llm' ? '再要約' : 'LLMで要約'}</button>` : ''}
    </div>
    <div class="summary" id="summary">${esc(s.summary)}</div>
    ${llm ? '' : '<p class="small">ANTHROPIC_API_KEY を設定して起動すると、LLMで要約できます。</p>'}
    ${s.changedFiles.length ? `<div class="section-title">変更ファイル</div><ul class="files">${s.changedFiles.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
    ${s.firstPrompt ? `<div class="section-title">最初の依頼</div><div class="prompt">${esc(s.firstPrompt)}</div>` : ''}
    <div class="section-title">詳細</div>
    <p class="meta">ツール: ${esc(tools || 'なし')}</p>
    <p class="meta">トークン: 入力 ${fmtNum(s.tokens.input + s.tokens.cacheRead + s.tokens.cacheCreation)}(キャッシュ読込 ${fmtNum(s.tokens.cacheRead)})/ 出力 ${fmtNum(s.tokens.output)}</p>
    <p class="meta">モデル: ${esc(s.models.join(', ') || '-')}</p>
    <p class="meta small">${esc(s.cwd || '')}<br>${esc(s.id)}</p>`;

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
$('prev').onclick = () => { state.weekStart = addDays(state.weekStart, -7); loadWeek(); };
$('next').onclick = () => { state.weekStart = addDays(state.weekStart, 7); loadWeek(); };
$('today').onclick = () => { state.weekStart = startOfWeek(new Date()); loadWeek(); };
$('project').onchange = (e) => { state.project = e.target.value; loadWeek(); runSearch(); };
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
  const refresh = () => { loadWeek(); if (state.q) runSearch(); };
  es.addEventListener('update', refresh);
  es.addEventListener('tick', refresh);
}

(async () => {
  state.config = await api('/api/config');
  await loadWeek();
  // 8時付近を初期表示位置にする
  $('cal-body').scrollTop = HOUR_PX * 8;
  connectEvents();
})();
