// タスクビュー: 期間内に動いたセッションをタスクIDごとにまとめて表示する
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// ツールの表示名(app.js がサーバーの設定から入れる)
let toolLabels = {};
export const setToolLabels = (m) => (toolLabels = m || {});
const SOURCE_LABEL = { prompt: '依頼', branch: 'ブランチ', commit: 'コミット', manual: '手動' };

function dur(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}`;
}
function usd(v) {
  return v === 0 ? '$0' : v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;
}
function day(iso) {
  return new Date(iso).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
}

// 画面の自動更新で描き直しても、開いた行と投稿したコメントのリンクは残す
const expanded = new Set();
const posted = new Map();
export function notePosted(taskId, url) {
  posted.set(taskId, url);
}

export const PROVIDER_LABEL = { github: 'GitHub', gitlab: 'GitLab', linear: 'Linear', jira: 'Jira', backlog: 'Backlog', notion: 'Notion' };
const CATEGORY_TITLE = { open: '未着手', in_progress: '進行中', done: '完了', canceled: '中止・見送り' };

// 課題の状態。サービスごとの状態名(stateLabel)を、4つの分類(stateCategory)の色で示す。色だけに頼らず文字でも示す
export function issueState(issue) {
  if (!issue) return '';
  const cat = issue.stateCategory || 'open';
  return `<span class="state ${esc(cat)}" title="${esc(CATEGORY_TITLE[cat] || '')}">${esc(issue.kindLabel || 'Issue')} ${esc(issue.stateLabel || '')}</span>`;
}

const ISSUE_ERROR = {
  not_found: '見つからないか、読む権限がありません',
  unauthorized: '認証情報が無いか、正しくありません',
  forbidden: '読む権限がありません',
  rate_limited: 'API の制限中です',
  timeout: '取得がタイムアウトしました',
  network: '接続できません',
};

function issueInfo(t) {
  if (t.issue) {
    const labels = t.issue.labels.map((l) => `<span class="label">${l.color ? `<span class="dot" style="background:#${esc(l.color)}"></span>` : ''}${esc(l.name)}</span>`).join('');
    const who = t.issue.assignees.length ? `<span class="small">担当 ${t.issue.assignees.map(esc).join(', ')}</span>` : '';
    const prio = t.issue.priority && t.issue.priority !== 'No priority' ? `<span class="small">優先度 ${esc(t.issue.priority)}</span>` : '';
    return `<div class="issue">${issueState(t.issue)} <span class="issue-title">${esc(t.issue.title)}</span></div><div class="issue-meta">${labels}${who}${prio}</div>`;
  }
  if (t.issueError) return `<div class="small">${esc(PROVIDER_LABEL[t.provider] || '')}: ${esc(ISSUE_ERROR[t.issueError] || t.issueError)}</div>`;
  return '';
}

export function taskLink(t) {
  return t.url
    ? `<a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${esc(t.label)}</a>`
    : `<span title="リンク先が分かりません。config.json の tasks.keyUrl / tasks.urls で設定できます">${esc(t.label)}</span>`;
}

export function renderTasks(root, tasks, { onSession, onComment }) {
  if (!tasks.length) {
    root.innerHTML = `<p class="hint">この期間に、タスクIDが見つかったセッションはありません。</p>
      <p class="small">依頼文・ブランチ名・コミットの件名にある <code>ABC-123</code>、<code>#123</code>、<code>owner/repo#123</code>、課題のURL、
      <code>123-fix-bug</code> のようなブランチ名を拾います。セッションの詳細パネルから手で紐付けることもできます。</p>`;
    return;
  }
  const totalMs = tasks.reduce((n, t) => n + t.activeMs, 0);
  root.innerHTML = `
    <p class="small">期間内に動いたセッションを、タスクごとにまとめています。時間・コスト・コミットはセッション全体の値で、1つのセッションが複数のタスクに紐付くとそれぞれに数えます。</p>
    <table class="task-table">
      <thead><tr><th>タスク</th><th>見つけた場所</th><th>プロジェクト</th><th class="n">セッション</th><th class="n">作業時間</th><th class="n">コミット</th><th class="n">コスト</th><th>期間</th></tr></thead>
      <tbody>${tasks.map((t, i) => `
        <tr class="task-row" data-i="${i}">
          <td><button class="toggle" aria-expanded="${expanded.has(t.id)}" aria-label="セッションを表示">${expanded.has(t.id) ? '▾' : '▸'}</button> ${taskLink(t)}${t.provider ? ` <span class="provider">${esc(PROVIDER_LABEL[t.provider])}</span>` : ''}${issueInfo(t)}</td>
          <td>${t.sources.map((s) => `<span class="badge">${esc(SOURCE_LABEL[s] || s)}</span>`).join('')}</td>
          <td>${t.projects.map(esc).join(', ')}</td>
          <td class="n">${t.sessions.length}</td>
          <td class="n"><span class="share" style="--w:${Math.round((t.activeMs / (totalMs || 1)) * 100)}%"></span>${dur(t.activeMs)}</td>
          <td class="n">${t.commits}</td>
          <td class="n">${usd(t.usd)}</td>
          <td>${day(t.first)}${day(t.first) !== day(t.last) ? ` 〜 ${day(t.last)}` : ''}</td>
        </tr>
        <tr class="task-sessions" data-i="${i}" ${expanded.has(t.id) ? '' : 'hidden'}><td colspan="8"><ul>${t.sessions.map((s) => `
          <li data-id="${esc(s.id)}"><span class="t">${esc(s.title)}</span>
            <span class="small">${s.tool && s.tool !== 'claude' ? `${esc(toolLabels[s.tool] || s.tool)} · ` : ''}${esc(s.project)} · ${day(s.start)} · ${dur(s.activeMs)} · ${s.commits}コミット · ${usd(s.usd)}</span></li>`).join('')}</ul>
          ${t.provider && t.issue ? `<button class="comment-btn" data-id="${esc(t.id)}">${esc(PROVIDER_LABEL[t.provider])} の ${esc(t.label)} に作業記録をコメント…</button>` : ''}
          ${posted.has(t.id) ? `<p class="small">投稿しました: ${posted.get(t.id) ? `<a href="${esc(posted.get(t.id))}" target="_blank" rel="noopener noreferrer">${esc(posted.get(t.id))}</a>` : ''}</p>` : ''}</td></tr>`).join('')}
      </tbody>
    </table>`;
  root.querySelectorAll('.task-row .toggle').forEach((b) => {
    b.addEventListener('click', () => {
      const i = b.closest('tr').dataset.i;
      const row = root.querySelector(`.task-sessions[data-i="${i}"]`);
      row.hidden = !row.hidden;
      if (row.hidden) expanded.delete(tasks[i].id);
      else expanded.add(tasks[i].id);
      b.setAttribute('aria-expanded', String(!row.hidden));
      b.textContent = row.hidden ? '▸' : '▾';
    });
  });
  root.querySelectorAll('.task-sessions li').forEach((li) => li.addEventListener('click', () => onSession(li.dataset.id)));
  root.querySelectorAll('.comment-btn').forEach((b) => b.addEventListener('click', () => onComment(b.dataset.id, b)));
}
