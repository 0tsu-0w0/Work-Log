// LLMを使わないルールベースの要約・タグ付け。APIキーが無いときの既定動作。
import { clipMasked } from './mask.js';

const WORK_TYPES = [
  ['バグ修正', /バグ|不具合|修正して|直して|エラー|落ちる|動かない|fix|bug|error|crash|broken|fails?\b/i],
  ['リファクタ', /リファクタ|整理して|共通化|refactor|clean ?up|simplify/i],
  ['テスト', /テスト|test|spec\b|CI\b/i],
  ['ドキュメント', /ドキュメント|README|docs?\b|説明書|仕様書|要件/i],
  ['機能', /実装|追加|作って|作成|機能|対応して|進めて|implement|add|create|build|feature|support/i],
  ['調査', /調査|調べ|確認して|なぜ|教えて|とは|investigate|why|how|what|\?$|？$/i],
];

// タイトルを重く、依頼文は出現回数で採点し、最高点の種別を採る(同点は WORK_TYPES の順)
export function classifyWorkType(session) {
  const count = (re, text) => (text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length;
  const prompts = (session.prompts || []).slice(0, 5).join('\n');
  let best = null;
  let bestScore = 0;
  for (const [type, re] of WORK_TYPES) {
    const score = count(re, session.title || '') * 3 + count(re, prompts);
    if (score > bestScore) [best, bestScore] = [type, score];
  }
  return best || (session.changedFiles?.length ? '機能' : '調査');
}

// 変更ファイルのパスから「コンポーネント」を推定する(上位ディレクトリ単位)
export function inferComponents(changedFiles = [], max = 4) {
  const counts = new Map();
  for (const f of changedFiles) {
    if (f.startsWith('/')) continue; // プロジェクト外のファイル
    const parts = f.split('/');
    let comp;
    if (parts.length === 1) comp = parts[0];
    else if (['src', 'lib', 'app', 'packages', 'apps', 'components', 'pkg', 'internal'].includes(parts[0]) && parts.length > 2)
      comp = `${parts[0]}/${parts[1]}`;
    else comp = parts[0];
    counts.set(comp, (counts.get(comp) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([c]) => c);
}

export function heuristicSummary(session) {
  const parts = [];
  if (session.firstPrompt) {
    // 依頼は Markdown で書かれることが多いので、強調・コード・見出しの記号を落として地の文にする
    const p = session.firstPrompt.replace(/\*\*|__|`+/g, '').replace(/^\s*#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim();
    parts.push(`依頼: ${clipMasked(p, 140)}`);
  }
  const acts = [];
  if (session.changedFiles?.length) acts.push(`${session.changedFiles.length}ファイルを変更`);
  if (session.commits) acts.push(`${session.commits}回コミット`);
  const bash = session.toolCalls?.Bash || 0;
  if (bash) acts.push(`コマンド${bash}回実行`);
  if (acts.length) parts.push(acts.join('、') + '。');
  return {
    summary: parts.join('\n') || '内容なし',
    workType: classifyWorkType(session),
    components: inferComponents(session.changedFiles),
    source: 'heuristic',
  };
}
