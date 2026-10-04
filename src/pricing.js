// Claude API の単価表と、利用量からの API 換算コスト計算。
// 出典: https://platform.claude.com/docs/en/about-claude/pricing (2026-10-04 時点)
// Claude Code を Pro/Max などの定額プランで使っている場合、実際の請求額とは異なる(API で使った場合の目安)。

export const PRICING_AS_OF = '2026-10-04';
export const PRICING_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
const WEB_SEARCH_PER_REQUEST = 10 / 1000; // $10 / 1,000 回

// 単位: USD / 100万トークン。cacheRead は入力単価に対する倍率がモデルで異なるので実額で持つ。
// geo: inference_geo "us" の 1.1 倍が適用されるモデル(4.6 以降)
// fast: fast モードの入力・出力単価(キャッシュの倍率はこの単価に掛かる)
const P = (family, input, output, cacheRead, extra = {}) => ({ family, input, output, cacheRead, geo: true, ...extra });
const MODELS = [
  ['claude-fable-5-1', P('Fable', 10, 50, 0.25)],
  ['claude-mythos-5-1', P('Fable', 10, 50, 0.25)],
  ['claude-fable-5', P('Fable', 10, 50, 1)],
  ['claude-mythos-5', P('Fable', 10, 50, 1)],
  ['claude-opus-5-5', P('Opus', 4, 20, 0.2, { fast: { input: 8, output: 40 } })],
  ['claude-opus-5', P('Opus', 5, 25, 0.5, { fast: { input: 10, output: 50 } })],
  ['claude-opus-4-8', P('Opus', 5, 25, 0.5, { fast: { input: 10, output: 50 } })],
  ['claude-opus-4-7', P('Opus', 5, 25, 0.5)],
  ['claude-opus-4-6', P('Opus', 5, 25, 0.5)],
  ['claude-opus-4-5', P('Opus', 5, 25, 0.5, { geo: false })],
  ['claude-opus-4-1', P('Opus', 15, 75, 1.5, { geo: false })],
  ['claude-opus-4', P('Opus', 15, 75, 1.5, { geo: false })],
  ['claude-sonnet-5-5', P('Sonnet', 2, 10, 0.2)],
  ['claude-sonnet-5', P('Sonnet', 2, 10, 0.2)],
  ['claude-sonnet-4-6', P('Sonnet', 3, 15, 0.3)],
  ['claude-sonnet-4-5', P('Sonnet', 3, 15, 0.3, { geo: false })],
  ['claude-sonnet-4', P('Sonnet', 3, 15, 0.3, { geo: false })],
  ['claude-haiku-4-5', P('Haiku', 1, 5, 0.1, { geo: false })],
  ['claude-3-5-haiku', P('Haiku', 0.8, 4, 0.08, { geo: false })],
];

// "claude-opus-4-5-20251101" のような日付付きIDや、"anthropic.claude-…"・"…[1m]" のような表記にも当てる。
// 長いIDから順に照合するので "claude-opus-4" が "claude-opus-4-5" を横取りしない。
const BY_LENGTH = [...MODELS].sort((a, b) => b[0].length - a[0].length);

export function priceFor(model) {
  if (typeof model !== 'string') return null;
  const id = model.toLowerCase().replace(/^.*?(claude-)/, '$1');
  for (const [prefix, price] of BY_LENGTH) {
    if (id === prefix || id.startsWith(prefix + '-') || id.startsWith(prefix + '[') || id.startsWith(prefix + '@')) return price;
  }
  return null;
}

export function modelFamily(model) {
  return priceFor(model)?.family || 'その他';
}

// tokens: [input, output, cacheRead, cacheWrite5m, cacheWrite1h, webSearches]
export function costOf(model, tokens, { fast = false, us = false } = {}) {
  const p = priceFor(model);
  if (!p) return null;
  const [input, output, cacheRead, cw5m, cw1h, searches] = tokens;
  const base = fast && p.fast ? p.fast : p;
  // fast モードでもキャッシュ読み込みは通常単価に対する比率のまま、fast の入力単価に掛かる
  const readRate = (p.cacheRead / p.input) * base.input;
  const usd =
    (input * base.input + output * base.output + cacheRead * readRate + cw5m * base.input * 1.25 + cw1h * base.input * 2) / 1e6;
  return usd * (us && p.geo ? 1.1 : 1) + (searches || 0) * WEB_SEARCH_PER_REQUEST;
}

// セッションの usage({"時|モデル|fast|us": tokens})を集計する
export function sessionCost(usage = {}) {
  let usd = 0;
  const unknownModels = new Set();
  for (const [key, tokens] of Object.entries(usage)) {
    const [, model, fast, us] = key.split('|');
    const c = costOf(model, tokens, { fast: fast === 'fast', us: us === 'us' });
    if (c === null) unknownModels.add(model);
    else usd += c;
  }
  return { usd, unknownModels: [...unknownModels] };
}
