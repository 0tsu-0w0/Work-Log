// セッション一覧の絞り込み(期間・プロジェクト・タグ・ツール・タスク・キーワード)
export function filterSessions(sessions, { from, to, project, tag, tool, task, q } = {}) {
  const fromMs = from ? Date.parse(from) : -Infinity;
  const toMs = to ? Date.parse(to) : Infinity;
  const needle = q?.trim().toLowerCase();
  return sessions.filter((s) => {
    if (Date.parse(s.end) < fromMs || Date.parse(s.start) >= toMs) return false;
    if (project && s.project !== project) return false;
    if (tool && (s.tool || 'claude') !== tool) return false;
    if (tag && s.workType !== tag && !s.components.includes(tag)) return false;
    if (task && !(s.tasks || []).some((t) => t.id === task || t.id.endsWith(task))) return false;
    if (needle) {
      const commits = (s.commitList || []).flatMap((c) => [c.hash, c.subject]);
      const tasks = (s.tasks || []).map((t) => t.id);
      const hay = [s.displayTitle, s.title, s.summary, s.project, s.gitBranch, ...s.prompts, ...s.changedFiles, ...s.components, ...commits, ...tasks]
        .filter(Boolean).join('\n').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}
