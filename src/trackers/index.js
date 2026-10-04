// 課題管理サービスの一覧と、タスクIDの振り分け。
// 振り分けの順: ログ中のURLのホスト → 設定(config.json の tasks.<サービス>.keys)→ 設定済みのサービスが1つだけならそれ
import { GitHubIssues } from '../github.js';
import { GitLabIssues, LinearIssues, JiraIssues, BacklogIssues, NotionPages } from './providers.js';

const KEY_PROVIDERS = ['linear', 'jira', 'backlog', 'notion'];

export class Trackers {
  constructor({ cacheDir, env = process.env, fetchImpl = fetch, github = null, config = {} } = {}) {
    this.cacheDir = cacheDir;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.github = github || new GitHubIssues({ cacheDir, env, fetchImpl });
    this.setConfig(config);
  }

  // config.json の tasks 部分。接続先(Jira の URL・Backlog のスペース・GitLab の URL)とキーのプレフィックス
  setConfig(tasksCfg = {}) {
    const c = (name) => (tasksCfg[name] && typeof tasksCfg[name] === 'object' ? tasksCfg[name] : {});
    this.cfg = { linear: c('linear'), jira: c('jira'), backlog: c('backlog'), gitlab: c('gitlab'), notion: c('notion') };
    const opts = { cacheDir: this.cacheDir, env: this.env, fetchImpl: this.fetchImpl };
    this.providers = {
      github: this.github,
      gitlab: new GitLabIssues({ ...opts, baseUrl: this.cfg.gitlab.baseUrl }),
      linear: new LinearIssues(opts),
      jira: new JiraIssues({ ...opts, baseUrl: this.cfg.jira.baseUrl }),
      backlog: new BacklogIssues({ ...opts, space: this.cfg.backlog.space }),
      notion: new NotionPages({ ...opts, databaseId: this.cfg.notion.databaseId, dataSourceId: this.cfg.notion.dataSourceId, idProperty: this.cfg.notion.idProperty }),
    };
    this.keysOf = Object.fromEntries(KEY_PROVIDERS.map((n) => [n, (this.cfg[n].keys || []).map((k) => String(k).toUpperCase())]));
  }

  get(name) {
    return this.providers[name] || null;
  }

  // GitLab として扱うホスト(gitlab.com と、設定した GitLab の URL のホスト)
  isGitLabHost(host) {
    return host === 'gitlab.com' || host === this.providers.gitlab.host() || /(^|\.)gitlab\./.test(host || '');
  }

  // ABC-123 形式のIDをどのサービスのものとみなすか
  keyProvider(ref) {
    if (ref.url) {
      const host = safeHost(ref.url);
      if (host === 'linear.app') return 'linear';
      if (host === 'notion.so' || host === 'www.notion.so' || host.endsWith('.notion.site')) return 'notion';
      if (/\.backlog(tool)?\.(jp|com)$/.test(host)) return 'backlog';
      if (/\/browse\//.test(ref.url) && (host.endsWith('.atlassian.net') || host === safeHost(this.providers.jira.baseUrl || ''))) return 'jira';
    }
    const prefix = ref.id.split('-')[0];
    for (const n of KEY_PROVIDERS) if (this.keysOf[n].includes(prefix)) return n;
    const configured = KEY_PROVIDERS.filter((n) => this.providers[n].configured());
    return configured.length === 1 ? configured[0] : null;
  }

  // 取得前に分かるリンク先(Jira / Backlog は接続先の設定から作れる。Linear は取得結果のURLを使う)
  keyUrl(provider, id) {
    if (provider === 'jira' && this.providers.jira.baseUrl) return this.providers.jira.browseUrl(id);
    if (provider === 'backlog' && this.providers.backlog.space) return this.providers.backlog.viewUrl(id);
    if (provider === 'linear' && this.cfg.linear.workspace) return `https://linear.app/${encodeURIComponent(this.cfg.linear.workspace)}/issue/${id}`;
    return null;
  }

  // タスクに課題の情報(タイトル・状態など)を付ける。取れなければ付けない
  async enrich(tasks, opts = {}) {
    const byProvider = new Map();
    for (const t of tasks) {
      const p = t.provider && this.providers[t.provider];
      if (!p || !p.valid(t)) continue;
      if (!byProvider.has(t.provider)) byProvider.set(t.provider, []);
      byProvider.get(t.provider).push(t);
    }
    const found = {};
    await Promise.all(
      [...byProvider].map(async ([name, refs]) => {
        const r = await this.providers[name].getMany(refs, opts);
        for (const [k, v] of Object.entries(r)) found[`${name}:${k}`] = v;
      }),
    );
    return tasks.map((t) => {
      const p = t.provider && this.providers[t.provider];
      const e = p && p.valid(t) ? found[`${t.provider}:${p.itemKey(t)}`] : null;
      return e ? { ...t, issue: e.data || null, issueError: e.error || null } : t;
    });
  }

  async status() {
    return Promise.all(Object.values(this.providers).map((p) => p.status()));
  }
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
