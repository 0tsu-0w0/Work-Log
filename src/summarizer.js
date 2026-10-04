// Claude API を使ったセッション要約(オプトイン)。送信前に必ずマスキングする。
import { mask } from './mask.js';
import { heuristicSummary } from './tagger.js';

export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_TRANSCRIPT_CHARS = 24000;

export function llmAvailable(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY);
}

export function buildDigest(session) {
  const lines = [
    `プロジェクト: ${session.project}`,
    session.gitBranch ? `ブランチ: ${session.gitBranch}` : null,
    `変更ファイル: ${session.changedFiles.slice(0, 40).join(', ') || 'なし'}`,
    `コミット数: ${session.commits}`,
    '',
    '## ユーザーの依頼',
    ...session.prompts.slice(0, 15).map((p, i) => `${i + 1}. ${p}`),
    '',
    '## 実行コマンド(抜粋)',
    ...session.commands.slice(-15).map((c) => `$ ${c}`),
    '',
    '## アシスタントの最終応答',
    session.lastAssistantText || '(なし)',
  ].filter((l) => l !== null);
  const digest = mask(lines.join('\n'));
  return digest.length > MAX_TRANSCRIPT_CHARS ? digest.slice(0, MAX_TRANSCRIPT_CHARS) + '\n…(省略)' : digest;
}

const SYSTEM = `あなたは開発作業ログの記録係です。Claude Codeのセッション記録を読み、何をした作業かを日本語で簡潔にまとめます。
必ず次のJSONだけを出力してください(前後に文章を付けない):
{"title": "20字程度の作業タイトル", "summary": "2〜3文の要約(何を・なぜ・結果)", "workType": "機能|バグ修正|リファクタ|テスト|ドキュメント|調査|課題 のいずれか", "components": ["関係するコンポーネント名(最大4つ)"]}`;

export function parseLlmJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('LLM応答にJSONが含まれていません');
  const j = JSON.parse(m[0]);
  return {
    title: typeof j.title === 'string' ? j.title : null,
    summary: String(j.summary || ''),
    workType: String(j.workType || '調査'),
    components: Array.isArray(j.components) ? j.components.map(String).slice(0, 4) : [],
  };
}

export async function summarizeWithLlm(session, { env = process.env, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.WORKLOG_MODEL || DEFAULT_MODEL,
      max_tokens: 600,
      system: SYSTEM,
      messages: [{ role: 'user', content: buildDigest(session) }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  return { ...parseLlmJson(text), source: 'llm', model: data.model };
}

export async function summarize(session, opts = {}) {
  if (opts.useLlm && llmAvailable(opts.env)) return summarizeWithLlm(session, opts);
  return heuristicSummary(session);
}
