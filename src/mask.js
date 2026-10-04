// 秘匿情報のマスキング。要約APIへ送る前と、画面に出す前に通す。
const PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, '[ANTHROPIC_KEY]'],
  [/sk-[A-Za-z0-9_-]{20,}/g, '[API_KEY]'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[GITHUB_TOKEN]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[GITHUB_TOKEN]'],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, '[SLACK_TOKEN]'],
  [/AKIA[0-9A-Z]{16}/g, '[AWS_KEY]'],
  [/AIza[0-9A-Za-z_-]{35}/g, '[GOOGLE_KEY]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[JWT]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[PRIVATE_KEY]'],
  [/(\b(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)(["']?)[^\s"']{4,}\2/gi, '$1[REDACTED]'],
  [/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[CREDENTIALS]@'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]'],
];

export function mask(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

// オブジェクトの中の文字列をすべてマスキングする
export function maskDeep(v) {
  if (typeof v === 'string') return mask(v);
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)]));
  return v;
}

// 長さを切り詰めるときは、先に伏せてから切る(後から伏せると、途中で切れたトークンの一部がパターンに合わずに残る)
export function clipMasked(text, n) {
  const m = mask(text);
  return m.length > n ? m.slice(0, n) + '…' : m;
}
