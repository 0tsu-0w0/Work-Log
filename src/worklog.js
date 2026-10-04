// 課題に投稿する作業記録の本文。サービスの書式に合わせて3通りに書き分ける:
//   markdown: GitHub / GitLab / Linear(表)
//   jira    : Jira の Wiki 記法(REST API v2 の文字列コメント)
//   plain   : Backlog(プロジェクトの記法が Backlog 記法でも Markdown でも崩れないよう、表を使わない)
export function buildWorkLog(t, { format = 'markdown', timeZone } = {}) {
  // 時刻は画面と同じタイムゾーンで書く(不正な指定はサーバーのタイムゾーン)
  let tz;
  try {
    tz = timeZone ? new Intl.DateTimeFormat('ja-JP', { timeZone }).resolvedOptions().timeZone : undefined;
  } catch {
    tz = undefined;
  }
  const fmt = (iso) => new Date(iso).toLocaleString('ja-JP', { timeZone: tz, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const dur = (ms) => {
    const m = Math.round(ms / 60000);
    return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}`;
  };
  const tool = (s) => (s.tool === 'codex' ? 'Codex' : 'Claude Code');
  const commits = (s) => `${s.commits}${s.hashes?.length ? ` (${s.hashes.join(' ')})` : ''}`;
  const summary = `${t.sessions.length}セッション・作業 ${dur(t.activeMs)}・${t.commits}コミット(${fmt(t.first)} 〜 ${fmt(t.last)})`;
  const footer = 'ローカルの AI コーディングツールのセッションログから Work Log で作成';

  if (format === 'jira') {
    // 表の区切り "|" と、記法として解釈される { } [ ] は全角にして崩れを防ぐ
    const cell = (v) => String(v).replace(/\n/g, ' ').replace(/[|{}[\]]/g, (c) => ({ '|': '｜', '{': '｛', '}': '｝', '[': '［', ']': '］' })[c]);
    return [
      'h3. 作業記録(Work Log)',
      '',
      cell(summary),
      '',
      '||開始||セッション||ツール||作業時間||コミット||',
      ...t.sessions.map((s) => `|${cell(fmt(s.start))}|${cell(s.title)}|${tool(s)}|${dur(s.activeMs)}|${cell(commits(s))}|`),
      '',
      `_${footer}_`,
    ].join('\n');
  }

  if (format === 'plain') {
    return [
      '■ 作業記録(Work Log)',
      summary,
      '',
      ...t.sessions.map((s) => `・${fmt(s.start)} ${String(s.title).replace(/\n/g, ' ')}(${tool(s)}、${dur(s.activeMs)}、${s.commits}コミット${s.hashes?.length ? ` ${s.hashes.join(' ')}` : ''})`),
      '',
      `※ ${footer}`,
    ].join('\n');
  }

  const cell = (v) => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    '### 作業記録(Work Log)',
    '',
    summary,
    '',
    '| 開始 | セッション | ツール | 作業時間 | コミット |',
    '| --- | --- | --- | --- | --- |',
    ...t.sessions.map((s) => `| ${fmt(s.start)} | ${cell(s.title)} | ${tool(s)} | ${dur(s.activeMs)} | ${cell(commits(s))} |`),
    '',
    `<sub>${footer}</sub>`,
  ].join('\n');
}
