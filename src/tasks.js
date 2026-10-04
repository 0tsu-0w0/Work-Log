// タスク管理連携: 依頼文・ブランチ名・コミットの件名からタスクIDを見つけ、セッションに紐付ける。
// 外部サービスには接続しない。リンク先のURLは、ログに出てきたURLか設定(config.json)のテンプレートから作る。
//
// 見つける形式:
//   ABC-123                      Linear / Jira などのキー形式
//   #123, owner/repo#123, GH-123 GitHub の issue / PR
//   https://github.com/o/r/issues/123, …/pull/123, https://linear.app/x/issue/ABC-123/…, https://x.atlassian.net/browse/ABC-123
//   ブランチ名 123-fix-bug, feature/123-…, fix/ABC-123-…

// キー形式に見えるが、タスクではないことが多いもの(規格名・モデル名など)
const DEFAULT_DENY = ['UTF', 'ISO', 'SHA', 'GPT', 'RFC', 'CVE', 'PEP', 'ES', 'HTTP', 'TLS', 'SSL', 'AES', 'RSA', 'MD', 'IPV', 'WIN', 'X', 'Q', 'CP', 'BASE', 'H', 'P', 'COVID', 'ECMA', 'IEEE', 'ANSI', 'JIS', 'MAC', 'CVSS', 'CWE', 'TS', 'ESLINT', 'NODE'];

const KEY_RE = /(?<![\w/.-])([A-Z][A-Z0-9]{1,9})-(\d{1,6})(?![\w-])/g;
const GH_URL_RE = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/g;
const GH_REF_RE = /(?<![\w&/])(?:([\w.-]+\/[\w.-]+))?#(\d{1,6})(?![\w])/g;
const GH_PREFIX_RE = /(?<![\w])GH-(\d{1,6})(?![\w-])/g;
const LINEAR_URL_RE = /https?:\/\/linear\.app\/[\w.-]+\/issue\/([A-Z][A-Z0-9]{1,9}-\d+)[^\s)>\]]*/g;
const JIRA_URL_RE = /(https?:\/\/[\w.-]+)\/browse\/([A-Z][A-Z0-9]{1,9}-\d+)/g;

export function normalizeConfig(cfg = {}) {
  const t = cfg.tasks || {};
  return {
    keys: Array.isArray(t.keys) ? t.keys.map((k) => String(k).toUpperCase()) : null, // 指定するとこのプレフィックスだけを拾う
    deny: new Set([...DEFAULT_DENY, ...(Array.isArray(t.deny) ? t.deny.map((k) => String(k).toUpperCase()) : [])]),
    keyUrl: typeof t.keyUrl === 'string' ? t.keyUrl : null, // 例: "https://linear.app/<team>/issue/{id}"
    urls: t.urls && typeof t.urls === 'object' ? t.urls : {}, // プレフィックス別: { "WEB": "https://<site>.atlassian.net/browse/{id}" }
    github: t.github !== false,
  };
}

// コードブロックや長いログの貼り付けに含まれる番号を拾いすぎないよう、``` で囲まれた部分は除く
function stripCode(text) {
  return String(text || '').replace(/```[\s\S]*?```/g, ' ');
}

function addRef(map, ref, source) {
  const key = ref.id;
  const cur = map.get(key) || { ...ref, sources: [] };
  if (!cur.url && ref.url) cur.url = ref.url;
  if (!cur.sources.includes(source)) cur.sources.push(source);
  map.set(key, cur);
}

export function refsFromText(text, source, cfg, map = new Map()) {
  const body = stripCode(text);
  // URL を先に拾い、同じIDのリンク先として使う
  for (const m of body.matchAll(LINEAR_URL_RE)) addRef(map, { id: m[1], kind: 'key', url: m[0].replace(/[.,]+$/, '') }, source);
  for (const m of body.matchAll(JIRA_URL_RE)) addRef(map, { id: m[2], kind: 'key', url: `${m[1]}/browse/${m[2]}` }, source);
  if (cfg.github) {
    for (const m of body.matchAll(GH_URL_RE)) addRef(map, { id: `${m[1]}#${m[2]}`, kind: 'github', repo: m[1], number: Number(m[2]), url: m[0] }, source);
  }
  const noUrls = body.replace(/https?:\/\/\S+/g, ' ');
  for (const m of noUrls.matchAll(KEY_RE)) {
    const prefix = m[1];
    if (cfg.keys ? !cfg.keys.includes(prefix) : cfg.deny.has(prefix) || prefix === 'GH') continue;
    addRef(map, { id: `${prefix}-${m[2]}`, kind: 'key' }, source);
  }
  if (cfg.github) {
    for (const m of noUrls.matchAll(GH_REF_RE)) {
      addRef(map, m[1] ? { id: `${m[1]}#${m[2]}`, kind: 'github', repo: m[1], number: Number(m[2]) } : { id: `#${m[2]}`, kind: 'github', number: Number(m[2]) }, source);
    }
    for (const m of noUrls.matchAll(GH_PREFIX_RE)) addRef(map, { id: `#${m[1]}`, kind: 'github', number: Number(m[1]) }, source);
  }
  return map;
}

// ブランチ名: "fix/ABC-123-title" はキー、"123-title" や "feature/123-title" は issue 番号とみなす
export function refsFromBranch(branch, cfg, map = new Map()) {
  if (!branch || ['main', 'master', 'develop', 'HEAD'].includes(branch)) return map;
  // "WEB-42-login" の番号の後ろの "-" は区切りとして扱う
  refsFromText(branch.replace(/[/_]/g, ' ').replace(/(\d)-/g, '$1 '), 'branch', { ...cfg, github: false }, map);
  if (cfg.github) {
    const m = branch.match(/(?:^|\/)(\d{1,6})(?:-|$)/);
    if (m) addRef(map, { id: `#${m[1]}`, kind: 'github', number: Number(m[1]) }, 'branch');
  }
  return map;
}

export function extractTaskRefs(session, cfg = normalizeConfig()) {
  const map = new Map();
  for (const p of session.prompts || []) refsFromText(p, 'prompt', cfg, map);
  refsFromBranch(session.gitBranch, cfg, map);
  for (const c of session.commitList || []) refsFromText(c.subject, 'commit', cfg, map);
  return [...map.values()];
}

// "#123" のようにリポジトリが書かれていない番号は、セッションのリポジトリのものとして扱う
export function resolveRef(ref, { repo, cfg }) {
  const r = { ...ref };
  if (r.kind === 'github' && !r.repo && repo) {
    r.repo = repo;
    r.id = `${repo}#${r.number}`;
  }
  if (!r.url) {
    if (r.kind === 'github' && r.repo) r.url = `https://github.com/${r.repo}/issues/${r.number}`; // PR 番号でも GitHub が転送する
    if (r.kind === 'key') {
      const prefix = r.id.split('-')[0];
      const tpl = cfg.urls[prefix] || cfg.keyUrl;
      if (tpl) r.url = tpl.replaceAll('{id}', r.id);
    }
  }
  r.label = r.kind === 'github' ? (r.repo ? `${r.repo.split('/')[1]}#${r.number}` : `#${r.number}`) : r.id;
  return r;
}

// "https://github.com/owner/repo" -> "owner/repo"
export function githubRepoOf(webBase) {
  const m = String(webBase || '').match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/);
  return m ? m[1] : null;
}
