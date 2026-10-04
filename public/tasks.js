// タスクビュー: 期間内に動いたセッションをタスクIDごとにまとめて表示する
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
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

// issue / PR の状態。色だけに頼らず文字でも示す
export function issueState(issue) {
  if (!issue) return '';
  const kind = issue.isPR ? 'PR' : 'Issue';
  const [cls, label] =
    issue.state === 'merged' ? ['merged', 'Merged']
    : issue.state === 'open' ? (issue.draft ? ['draft', 'Draft'] : ['open', 'Open'])
    : issue.stateReason === 'not_planned' || issue.isPR ? ['closed-other', 'Closed']
    : ['done', 'Closed'];
  return `<span class="state ${cls}" title="${kind}">${kind} ${label}</span>`;
}

const ISSUE_ERROR = { not_found: '見つからないか、読む権限がありません', rate_limited: 'GitHub の API 制限中です', timeout: '取得がタイムアウトしました', network: 'GitHub に接続できません' };

function issueInfo(t) {
  if (t.issue) {
    const labels = t.issue.labels.map((l) => `<span class="label">${l.color ? `<span class="dot" style="background:#${esc(l.color)}"></span>` : ''}${esc(l.name)}</span>`).join('');
    const who = t.issue.assignees.length ? `<span class="small">担当 ${t.issue.assignees.map(esc).join(', ')}</span>` : '';
    return `<div class="issue">${issueState(t.issue)} <span class="issue-title">${esc(t.issue.title)}</span></div><div class="issue-meta">${labels}${who}</div>`;
  }
  if (t.issueError) return `<div class="small">GitHub: ${esc(ISSUE_ERROR[t.issueError] || t.issueError)}</div>`;
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
          <td><button class="toggle" aria-expanded="false" aria-label="セッションを表示">▸</button> ${taskLink(t)}${issueInfo(t)}</td>
          <td>${t.sources.map((s) => `<span class="badge">${esc(SOURCE_LABEL[s] || s)}</span>`).join('')}</td>
          <td>${t.projects.map(esc).join(', ')}</td>
          <td class="n">${t.sessions.length}</td>
          <td class="n"><span class="share" style="--w:${Math.round((t.activeMs / (totalMs || 1)) * 100)}%"></span>${dur(t.activeMs)}</td>
          <td class="n">${t.commits}</td>
          <td class="n">${usd(t.usd)}</td>
          <td>${day(t.first)}${day(t.first) !== day(t.last) ? ` 〜 ${day(t.last)}` : ''}</td>
        </tr>
        <tr class="task-sessions" data-i="${i}" hidden><td colspan="8"><ul>${t.sessions.map((s) => `
          <li data-id="${esc(s.id)}"><span class="t">${esc(s.title)}</span>
            <span class="small">${s.tool === 'codex' ? 'Codex · ' : ''}${esc(s.project)} · ${day(s.start)} · ${dur(s.activeMs)} · ${s.commits}コミット · ${usd(s.usd)}</span></li>`).join('')}</ul>
          ${t.kind === 'github' && t.repo && t.issueError !== 'not_found' ? `<button class="comment-btn" data-id="${esc(t.id)}">この${t.issue?.isPR ? 'PR' : ' issue '}に作業記録をコメント…</button>` : ''}</td></tr>`).join('')}
      </tbody>
    </table>`;
  root.querySelectorAll('.task-row .toggle').forEach((b) => {
    b.addEventListener('click', () => {
      const i = b.closest('tr').dataset.i;
      const row = root.querySelector(`.task-sessions[data-i="${i}"]`);
      row.hidden = !row.hidden;
      b.setAttribute('aria-expanded', String(!row.hidden));
      b.textContent = row.hidden ? '▸' : '▾';
    });
  });
  root.querySelectorAll('.task-sessions li').forEach((li) => li.addEventListener('click', () => onSession(li.dataset.id)));
  root.querySelectorAll('.comment-btn').forEach((b) => b.addEventListener('click', () => onComment(b.dataset.id, b)));
}
