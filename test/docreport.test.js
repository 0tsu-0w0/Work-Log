import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/report.js';
import { toConfluence, toEsa, toObsidian, sessionEndObsidian, mdEsc, xEsc, noteName, plainFromMarkdown } from '../src/docreport.js';
import { range, weekRange, one } from './doc-helpers.js';

const tricky = '# 見出し | a<b> *x* _y_ [z](http://e) `c` ~d~ $e$ & "q"';
const report = () =>
  buildReport({
    sessions: [one(1, tricky), one(2, '- 箇条書き', { tool: 'codex' })],
    tasks: [
      { id: 'WEB-1', label: 'WEB-1', url: 'https://x.example/browse/WEB-1?a=(b) c', issue: { title: 'A_B <x>', stateLabel: 'Done' }, sessions: [{ id: 's1' }] },
      { id: 'X', label: 'X', url: 'javascript:alert(1)', sessions: [{ id: 's2' }] },
    ],
    costs: { buckets: [{ usd: 2 }] },
    range,
  });

test('Markdown: 表・見出し・リンクを壊す記号を逃がす', () => {
  assert.equal(mdEsc('# a'), '\\# a');
  assert.equal(mdEsc('1. a'), '1\\. a');
  assert.equal(mdEsc('cc @alice and a@b'), 'cc ＠alice and a＠b'); // メンションにしない
  assert.equal(mdEsc('a|b\nc'), 'a\\|b c');
  const m = toEsa(report(), { includeCost: true });
  assert.equal(m.kind, 'report');
  assert.equal(m.title, 'Work Log 日報 2026-10-04(日)');
  assert.equal(m.period, 'day');
  assert.equal(m.start, '2026-10-04');
  assert.ok(m.body.startsWith('作業 40分・2セッション・0コミット・API換算 \\$2.00(参考値)\n\n## プロジェクト別\n\n| プロジェクト | 作業時間 | セッション | コミット |'), m.body);
  assert.ok(m.body.includes('\\# 見出し \\| a\\<b\\> \\*x\\* \\_y\\_ \\[z\\](http://e) \\`c\\` \\~d\\~ \\$e\\$ \\& "q"'), m.body);
  assert.ok(m.body.includes('\\- 箇条書き(Codex)'), m.body);
  assert.ok(m.body.includes('- [WEB-1](https://x.example/browse/WEB-1?a=%28b%29%20c) A\\_B \\<x\\>(Done)  20分'), m.body);
  assert.doesNotMatch(m.body, /javascript:/); // http(s) 以外はリンクにしない
  assert.ok(m.body.endsWith('*ローカルの AI コーディングツールのセッションログから Work Log で作成*'));
  assert.ok(m.preview.startsWith('# Work Log 日報 2026-10-04(日)'));
  assert.doesNotMatch(toEsa(report()).body, /API換算/); // コストは指定したときだけ
});

test('Markdown: セッションは多いときに件数を絞る', () => {
  const r = buildReport({ sessions: Array.from({ length: 30 }, (_, i) => one(i)), range });
  const m = toEsa(r, { maxSessions: 10 });
  assert.match(m.body, /ほか 20 セッション\n/);
  assert.equal(m.body.split('\n').filter((l) => /^\| \d\d:\d\d \|/.test(l)).length, 10);
});

test('Confluence: storage format(XHTML)で & < > " を逃がす', () => {
  assert.equal(xEsc('a&b<c>"d"\u0001\n'), 'a&amp;b&lt;c&gt;&quot;d&quot; ');
  const m = toConfluence(report(), { includeCost: true });
  assert.equal(m.title, 'Work Log 日報 2026/10/4(日)');
  assert.ok(m.body.startsWith('<p>作業 40分・2セッション・0コミット・API換算 $2.00(参考値)</p><h2>プロジェクト別</h2><table><tbody><tr><th>プロジェクト</th>'), m.body);
  assert.ok(m.body.includes('<td># 見出し | a&lt;b&gt; *x* _y_ [z](http://e) `c` ~d~ $e$ &amp; &quot;q&quot;</td>'), m.body);
  assert.ok(m.body.includes('<li><a href="https://x.example/browse/WEB-1?a=(b) c">WEB-1</a> A_B &lt;x&gt;(Done)  20分</li>'), m.body);
  assert.doesNotMatch(m.body, /javascript:|<script/);
  assert.ok(m.body.endsWith('<hr /><p><em>ローカルの AI コーディングツールのセッションログから Work Log で作成</em></p>'));
  // タグの外に、逃がしていない < > & が残らない
  const text = m.body.replace(/<\/?(p|h2|table|tbody|tr|th|td|ul|li|em|a( href="[^"]*")?)>|<hr \/>/g, '');
  assert.doesNotMatch(text.replace(/&(amp|lt|gt|quot|#39);/g, ''), /[<>&]/);
  assert.equal(toConfluence(buildReport({ sessions: [], range })).body.startsWith('<p>この期間の作業はありません。</p><hr />'), true);
});

test('Obsidian: プロパティ付きの本文と、日報・週報のファイル名', () => {
  const m = toObsidian(report());
  assert.ok(m.body.startsWith('---\ndate: 2026-10-04\nperiod: day\ntags: [work-log]\n---\n\n作業 40分'), m.body);
  assert.equal(noteName('day', '2026-10-04'), '2026-10-04 日報.md');
  assert.equal(noteName('week', '2026-09-28'), '2026-W40 週報.md');
  assert.equal(noteName('week', '2024-12-30'), '2025-W01 週報.md'); // 年をまたぐ週は ISO 週の年
  assert.equal(noteName('week', '2027-01-04'), '2027-W01 週報.md');
  const w = toObsidian(buildReport({ sessions: [one(1)], range: weekRange }));
  assert.equal(w.title, 'Work Log 週報 2026-09-28(月) 〜 10-04(日)');
  assert.equal(w.start, '2026-09-28');
  assert.equal(w.period, 'week');
});

test('Obsidian: セッション終了は日付と1行', () => {
  const m = sessionEndObsidian({ displayTitle: '# ログイン|修正', project: 'web', end: '2026-10-04T23:30:00Z', activeMs: 25 * 60000, commits: 1, tasks: [{ label: '#12', url: 'https://github.com/a/b/issues/12' }] }, { timeZone: 'Asia/Tokyo' });
  assert.deepEqual(m, { kind: 'session', date: '2026-10-05', line: '- 08:30 \\# ログイン\\|修正 — web・25分・1コミット・タスク: [\\#12](https://github.com/a/b/issues/12)' });
});

test('プレビュー用のプレーンテキスト', () => {
  const p = plainFromMarkdown(toEsa(report()).preview);
  assert.ok(p.startsWith('Work Log 日報 2026-10-04(日)\n'), p);
  assert.doesNotMatch(p, /\| ---|^##/m);
  assert.ok(p.includes('WEB-1 (https://x.example/browse/WEB-1?a=%28b%29%20c) A_B <x>(Done)  20分'), p);
  assert.ok(p.includes('# 見出し | a<b> *x* _y_ [z](http://e)'), p);
});
