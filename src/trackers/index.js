// 課題管理サービスの一覧と、タスクIDの振り分け。
// 振り分けの順: ログ中のURLのホスト → 設定(config.json の tasks.<サービス>.keys)→ 設定済みのサービスが1つだけならそれ
// Redmine の番号("#123")と Gitea / Forgejo のリポジトリの番号("owner/repo#12")は GitHub と同じ形なので、次の順で決める:
//   URL(REDMINE_URL / GITEA_URL の下の課題のURL)→ 設定(tasks.redmine.projects / tasks.redmine.keys / tasks.gitea.repos)
//   → セッションのリポジトリのホスト(Gitea のホストなら Gitea)→ リポジトリの無いセッションで Redmine を設定していれば Redmine
import { GitHubIssues } from '../github.js';
import { GitLabIssues, LinearIssues, JiraIssues, BacklogIssues, NotionPages } from './providers.js';
import { RedmineIssues } from './redmine.js';
import { GiteaIssues } from './gitea.js';

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
    this.cfg = { linear: c('linear'), jira: c('jira'), backlog: c('backlog'), gitlab: c('gitlab'), notion: c('notion'), redmine: c('redmine'), gitea: c('gitea') };
    const opts = { cacheDir: this.cacheDir, env: this.env, fetchImpl: this.fetchImpl };
    this.providers = {
      github: this.github,
      gitlab: new GitLabIssues({ ...opts, baseUrl: this.cfg.gitlab.baseUrl }),
      linear: new LinearIssues(opts),
      jira: new JiraIssues({ ...opts, baseUrl: this.cfg.jira.baseUrl }),
      backlog: new BacklogIssues({ ...opts, space: this.cfg.backlog.space }),
      notion: new NotionPages({ ...opts, databaseId: this.cfg.notion.databaseId, dataSourceId: this.cfg.notion.dataSourceId, idProperty: this.cfg.notion.idProperty }),
      redmine: new RedmineIssues({ ...opts, baseUrl: this.cfg.redmine.baseUrl, format: this.cfg.redmine.format }),
      gitea: new GiteaIssues({ ...opts, baseUrl: this.cfg.gitea.baseUrl, repos: this.cfg.gitea.repos }),
    };
    const keys = (n) => (Array.isArray(this.cfg[n].keys) ? this.cfg[n].keys : []).map((k) => String(k).toUpperCase());
    this.keysOf = Object.fromEntries([...KEY_PROVIDERS, 'redmine'].map((n) => [n, keys(n)]));
    this.redmineProjects = Array.isArray(this.cfg.redmine.projects) ? this.cfg.redmine.projects.map(String) : [];
  }

  get(name) {
    return this.providers[name] || null;
  }

  // GitLab として扱うホスト(gitlab.com と、設定した GitLab の URL のホスト)
  isGitLabHost(host) {
    return host === 'gitlab.com' || host === this.providers.gitlab.host() || /(^|\.)gitlab\./.test(host || '');
  }

  // Gitea として扱うホスト(設定した Gitea の URL のホストだけ。名前からは推測しない)
  isGiteaHost(host) {
    return Boolean(host) && host === this.providers.gitea.host();
  }

  // 番号だけの "#123" を Redmine の課題とみなすか。project はセッションのプロジェクト名、info はセッションのリポジトリ
  redmineHashRef(project, info) {
    if (!this.providers.redmine.configured()) return false;
    if (this.redmineProjects.includes('*') || (project && this.redmineProjects.includes(project))) return true;
    return !info; // リポジトリの無いセッションの "#123" は GitHub / GitLab / Gitea のものではありえない
  }

  // GitHub・GitLab 以外の課題のURL(Redmine / Gitea)を、設定した接続先と照らし合わせて解決する。合わなければ null
  urlRef(url) {
    const n = this.providers.redmine.numberOfUrl(url);
    if (n) return { provider: 'redmine', ...this.redmineRef(n) };
    const g = this.providers.gitea.refOfUrl(url);
    if (g) return { provider: 'gitea', id: `${g.repo}#${g.number}`, repo: g.repo, number: g.number, host: this.providers.gitea.host(), url: this.providers.gitea.issueUrl(g.repo, g.number, g.pull), label: `${g.repo.split('/').pop()}#${g.number}` };
    return null;
  }

  // Redmine の課題の ID とラベル。"#123" は GitHub と見分けがつかないので、ID には "redmine" を付ける
  redmineRef(n) {
    return { id: `redmine#${n}`, number: n, url: this.providers.redmine.issueUrl(n), label: `Redmine #${n}` };
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
    // Redmine の課題は番号だけなので、プレフィックスを設定したときだけ(設定済みのサービスが1つでも、それだけでは選ばない)
    if (this.keysOf.redmine.includes(prefix) && this.providers.redmine.configured()) return 'redmine';
    for (const n of KEY_PROVIDERS) if (this.keysOf[n].includes(prefix)) return n;
    const configured = KEY_PROVIDERS.filter((n) => this.providers[n].configured());
    return configured.length === 1 ? configured[0] : null;
  }

  // 取得前に分かるリンク先(Jira / Backlog は接続先の設定から作れる。Linear は取得結果のURLを使う)
  keyUrl(provider, id) {
    if (provider === 'jira' && this.providers.jira.baseUrl) return this.providers.jira.browseUrl(id);
    if (provider === 'backlog' && this.providers.backlog.space) return this.providers.backlog.viewUrl(id);
    if (provider === 'redmine') return this.providers.redmine.issueUrl(Number(id.split('-').pop()));
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
