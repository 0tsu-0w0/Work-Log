// Git 連携: セッションの作業ディレクトリのリポジトリを読み、コミットをセッションに紐付ける。
// 読み取り専用のコマンド(rev-parse / config / remote / log)だけを、シェルを介さずに実行する。
import { execFile } from 'node:child_process';
import path from 'node:path';

// セッションの区間の少し前後までを「セッション中のコミット」とみなす
export const WINDOW_BEFORE_MS = 2 * 60 * 1000;
export const WINDOW_AFTER_MS = 10 * 60 * 1000;
// ハッシュが出なかったコミット(git commit -q)の実行時刻と、コミット時刻のずれの許容幅
const QUIET_MATCH_MS = 2 * 60 * 1000;
const MAX_COMMITS = 300;
const MAX_LOOKUPS = 20;
const FS = '\x1f';
const RS = '\x1e';
const LOG_FORMAT = `--format=${RS}%H${FS}%h${FS}%an${FS}%ae${FS}%aI${FS}%cI${FS}%s`;

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', ...args],
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

// リモートURLからWeb上のリポジトリURLを作る(認証情報は落とす)
export function webBaseFromRemote(url) {
  if (!url) return null;
  const u = url.trim();
  let m = u.match(/^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/); // git@github.com:owner/repo.git
  if (!m) m = u.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return `https://${m[1]}/${m[2]}`;
}

export function commitUrl(webBase, hash) {
  if (!webBase) return null;
  const host = new URL(webBase).hostname;
  if (host.includes('gitlab')) return `${webBase}/-/commit/${hash}`;
  if (host.includes('bitbucket')) return `${webBase}/commits/${hash}`;
  return `${webBase}/commit/${hash}`;
}

export function parseLog(stdout) {
  const commits = [];
  for (const rec of stdout.split(RS)) {
    if (!rec.trim()) continue;
    const [header, ...rest] = rec.split('\n');
    const [hash, short, author, email, authorDate, commitDate, subject] = header.split(FS);
    if (!hash) continue;
    let insertions = 0;
    let deletions = 0;
    const files = [];
    for (const line of rest) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      if (m[1] !== '-') insertions += Number(m[1]);
      if (m[2] !== '-') deletions += Number(m[2]);
      files.push(m[3]);
    }
    commits.push({ hash, short, author, email, authorDate, commitDate, subject, insertions, deletions, files });
  }
  return commits;
}

function inWindow(t, segments) {
  return segments.some((g) => t >= Date.parse(g.start) - WINDOW_BEFORE_MS && t <= Date.parse(g.end) + WINDOW_AFTER_MS);
}

// session.commitList(Claudeが実行して成功したコミット)と、同じ時間帯に同じ作者が作ったコミットを集める
// 作業ディレクトリのリポジトリのWeb上のURL(origin)。リポジトリでなければ null
export async function remoteWebBase(cwd) {
  if (!cwd || !path.isAbsolute(cwd)) return null;
  try {
    return webBaseFromRemote((await git(cwd, ['remote', 'get-url', 'origin'])).trim());
  } catch {
    return null;
  }
}

export async function sessionGit(session, { now = Date.now() } = {}) {
  const cwd = session.cwd;
  if (!cwd || !path.isAbsolute(cwd) || !session.segments?.length) return { available: false, reason: 'no-cwd' };
  let root;
  try {
    root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch (err) {
    return { available: false, reason: err.code === 'ENOENT' ? 'no-git' : 'not-repo' };
  }
  const [email, remote] = await Promise.all([
    git(root, ['config', 'user.email']).then((s) => s.trim(), () => ''),
    git(root, ['remote', 'get-url', 'origin']).then((s) => s.trim(), () => ''),
  ]);

  const segments = session.segments.map((g, i) =>
    // 作業中なら最後の区間を現在まで広げる
    session.status === 'working' && i === session.segments.length - 1 ? { ...g, end: new Date(Math.max(Date.parse(g.end), now)).toISOString() } : g,
  );
  const since = new Date(Date.parse(segments[0].start) - WINDOW_BEFORE_MS).toISOString();
  const until = new Date(Date.parse(segments[segments.length - 1].end) + WINDOW_AFTER_MS).toISOString();
  let inRange = [];
  try {
    inRange = parseLog(await git(root, ['log', '--all', '--no-color', LOG_FORMAT, '--numstat', `--since=${since}`, `--until=${until}`, '-n', String(MAX_COMMITS)]));
  } catch {
    // 空のリポジトリなど
  }

  const fromClaude = session.commitList || [];
  const isClaude = (hash) => fromClaude.some((c) => hash.startsWith(c.hash));
  const quiet = (session.quietCommits || []).map(Date.parse);
  const isQuietClaude = (c) => quiet.some((t) => Math.abs(Date.parse(c.commitDate) - t) <= QUIET_MATCH_MS);
  const byHash = new Map();
  for (const c of inRange) {
    if (isClaude(c.hash)) byHash.set(c.hash, { ...c, source: 'claude' });
    else if (isQuietClaude(c) && (!email || c.email.toLowerCase() === email.toLowerCase())) byHash.set(c.hash, { ...c, source: 'claude' });
    else if (inWindow(Date.parse(c.commitDate), segments) && (!email || c.email.toLowerCase() === email.toLowerCase())) byHash.set(c.hash, { ...c, source: 'time' });
  }

  // 時間帯の外にある(日付を変えて作り直したなど)Claudeのコミットを個別に探す
  const missing = [];
  for (const c of fromClaude.slice(0, MAX_LOOKUPS)) {
    if ([...byHash.keys()].some((h) => h.startsWith(c.hash))) continue;
    try {
      const [found] = parseLog(await git(root, ['log', '-1', '--no-color', LOG_FORMAT, '--numstat', `${c.hash}^{commit}`, '--']));
      if (found) byHash.set(found.hash, { ...found, source: 'claude' });
      else missing.push(c);
    } catch {
      missing.push(c); // amend・rebase で書き換えられた、別の環境でコミットした、など
    }
  }

  const webBase = webBaseFromRemote(remote);
  const commits = [...byHash.values()]
    .sort((a, b) => Date.parse(a.commitDate) - Date.parse(b.commitDate))
    .map(({ email: _e, ...c }) => ({ ...c, url: commitUrl(webBase, c.hash) }));
  return {
    available: true,
    root,
    webBase,
    commits,
    missing,
    totals: {
      commits: commits.length,
      insertions: commits.reduce((s, c) => s + c.insertions, 0),
      deletions: commits.reduce((s, c) => s + c.deletions, 0),
      files: new Set(commits.flatMap((c) => c.files)).size,
    },
  };
}
