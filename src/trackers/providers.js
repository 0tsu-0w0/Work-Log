// 各課題管理サービスの取得・コメント投稿。API の形は公式の SDK / ドキュメントに合わせている:
//   Linear  : @linear/sdk の型定義(issue(id) は識別子 ENG-123 も可、commentCreate の issueId も識別子可、Authorization は API キーそのもの)
//   GitLab  : gitlabhq の doc/api(issues / merge_requests / notes、PRIVATE-TOKEN、パスは %2F でエンコード)
//   Jira    : REST API v2(GET /rest/api/2/issue/{key}、文字列のコメントは v2 の /comment。Cloud は Basic、Server/DC は PAT の Bearer)
//   Backlog : nulab/backlog-js(GET /api/v2/issues/:key、Backlog-API-Key ヘッダー、コメントは form の content)
import { CachedTracker, safeColor } from './base.js';

const ok = (data, res, now) => ({ etag: res.headers.get('etag'), fetchedAt: now, data });

// ---------------------------------------------------------------- GitLab
const GITLAB_STATE = { opened: ['open', 'Open'], closed: ['canceled', 'Closed'], merged: ['done', 'Merged'], locked: ['canceled', 'Locked'] };

export class GitLabIssues extends CachedTracker {
  constructor({ baseUrl, ...opts } = {}) {
    super({ name: 'gitlab', label: 'GitLab', ...opts });
    this.baseUrl = (baseUrl || this.env.GITLAB_URL || 'https://gitlab.com').replace(/\/+$/, '');
  }
  host() {
    return new URL(this.baseUrl).host;
  }
  itemKey(r) {
    return `${r.repo}${r.mr ? '!' : '#'}${r.number}`;
  }
  // グループは入れ子にできるので、パスは2段以上を許す("." や ".." だけの段は不可)
  valid(r) {
    return /^[\w.-]+(\/[\w.-]+)+$/.test(r.repo || '') && !r.repo.split('/').some((p) => p === '.' || p === '..') && Number.isInteger(r.number);
  }
  token() {
    return this.env.GITLAB_TOKEN || null;
  }
  async authenticated() {
    return Boolean(this.token());
  }
  headers() {
    const t = this.token();
    return t ? { 'private-token': t, accept: 'application/json' } : { accept: 'application/json' };
  }
  url(r, suffix = '') {
    return `${this.baseUrl}/api/v4/projects/${encodeURIComponent(r.repo)}/${r.mr ? 'merge_requests' : 'issues'}/${r.number}${suffix}`;
  }
  async fetchItem(r, entry, now) {
    const res = await this.http('GET', this.url(r), { headers: this.headers(), etag: entry?.etag });
    if (res.status === 304 && entry) return { ...entry, fetchedAt: now };
    if (!res.ok) return { ...(entry || {}), error: this.errorOf(res, now), fetchedAt: now };
    const j = await res.json();
    // 課題を閉じた場合は「完了」とみなす(GitLab には完了/見送りの区別が無い)
    const [cat, label] = r.mr ? GITLAB_STATE[j.state] || ['open', j.state] : j.state === 'closed' ? ['done', 'Closed'] : ['open', 'Open'];
    return ok(
      {
        title: j.title,
        state: j.state,
        stateCategory: j.draft && j.state === 'opened' ? 'in_progress' : cat,
        stateLabel: j.draft && j.state === 'opened' ? 'Draft' : label,
        kindLabel: r.mr ? 'MR' : 'Issue',
        isPR: Boolean(r.mr),
        draft: Boolean(j.draft),
        labels: (j.labels || []).map((l) => (typeof l === 'string' ? { name: l, color: null } : { name: l.name, color: safeColor(l.color) })),
        assignees: (j.assignees || []).map((a) => a.username),
        url: j.web_url,
        updatedAt: j.updated_at,
      },
      res,
      now,
    );
  }
  async comment(r, body) {
    if (!this.token()) throw new Error('GitLab へのコメントには GITLAB_TOKEN が必要です');
    const res = await this.http('POST', this.url(r, '/notes'), { headers: { ...this.headers(), 'content-type': 'application/json' }, body: JSON.stringify({ body }) });
    if (!res.ok) throw new Error(`GitLab API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const j = await res.json();
    this.invalidate(r);
    // ノートの API は URL を返さないので、課題のページの該当ノートを指す
    const page = this.cache[this.itemKey(r)]?.data?.url;
    return { url: page && j.id ? `${page}#note_${j.id}` : page || null };
  }
}

// ---------------------------------------------------------------- Linear
const LINEAR_STATE = { triage: 'open', backlog: 'open', unstarted: 'open', started: 'in_progress', completed: 'done', canceled: 'canceled', duplicate: 'canceled' };
const LINEAR_ISSUE = `query WorkLogIssue($id: String!) { issue(id: $id) { identifier title url updatedAt priorityLabel state { name type } labels { nodes { name color } } assignee { name displayName } } }`;
const LINEAR_COMMENT = `mutation WorkLogComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { url } } }`;

export class LinearIssues extends CachedTracker {
  constructor({ apiUrl, ...opts } = {}) {
    super({ name: 'linear', label: 'Linear', ...opts });
    this.apiUrl = apiUrl || this.env.WORKLOG_LINEAR_API || 'https://api.linear.app/graphql';
  }
  itemKey(r) {
    return r.id;
  }
  valid(r) {
    return /^[A-Z][A-Z0-9_]{0,9}-\d{1,7}$/.test(r.id || '');
  }
  key() {
    return this.env.LINEAR_API_KEY || null;
  }
  configured() {
    return Boolean(this.key());
  }
  async authenticated() {
    return Boolean(this.key());
  }
  async gql(query, variables) {
    // 個人 API キーは Bearer を付けずにそのまま送る(OAuth のトークンなら Bearer 付き)
    const k = this.key();
    const auth = k?.startsWith('lin_oauth') ? `Bearer ${k}` : k;
    return this.http('POST', this.apiUrl, { headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  }
  async fetchItem(r, entry, now) {
    if (!this.key()) return { ...(entry || {}), error: 'unauthorized', fetchedAt: now };
    const res = await this.gql(LINEAR_ISSUE, { id: r.id });
    if (!res.ok) return { ...(entry || {}), error: this.errorOf(res, now), fetchedAt: now };
    const j = await res.json();
    const i = j.data?.issue;
    if (!i) {
      // GraphQL のエラーは HTTP 200 で返ることがある
      const code = j.errors?.[0]?.extensions?.code;
      const error = code === 'RATELIMITED' ? 'rate_limited' : code === 'AUTHENTICATION_ERROR' ? 'unauthorized' : code === 'FORBIDDEN' ? 'forbidden' : 'not_found';
      return { ...(entry || {}), error, fetchedAt: now };
    }
    return ok(
      {
        title: i.title,
        state: i.state?.type,
        stateCategory: LINEAR_STATE[i.state?.type] || 'open',
        stateLabel: i.state?.name || i.state?.type,
        kindLabel: 'Issue',
        isPR: false,
        draft: false,
        labels: (i.labels?.nodes || []).map((l) => ({ name: l.name, color: safeColor(l.color) })),
        assignees: i.assignee ? [i.assignee.displayName || i.assignee.name] : [],
        priority: i.priorityLabel || null,
        url: i.url,
        updatedAt: i.updatedAt,
      },
      res,
      now,
    );
  }
  async comment(r, body) {
    if (!this.key()) throw new Error('Linear へのコメントには LINEAR_API_KEY が必要です');
    const res = await this.gql(LINEAR_COMMENT, { issueId: r.id, body });
    const j = res.ok ? await res.json() : null;
    if (!j?.data?.commentCreate?.success) throw new Error(`Linear API: ${j?.errors?.[0]?.message || res.status}`);
    this.invalidate(r);
    return { url: j.data.commentCreate.comment?.url || null };
  }
}

// ---------------------------------------------------------------- Jira
const JIRA_CATEGORY = { new: 'open', indeterminate: 'in_progress', done: 'done' };

export class JiraIssues extends CachedTracker {
  constructor({ baseUrl, ...opts } = {}) {
    super({ name: 'jira', label: 'Jira', ...opts });
    this.baseUrl = (baseUrl || this.env.JIRA_BASE_URL || '').replace(/\/+$/, '') || null;
  }
  itemKey(r) {
    return r.id;
  }
  valid(r) {
    return Boolean(this.baseUrl) && /^[A-Z][A-Z0-9_]{0,9}-\d{1,7}$/.test(r.id || '');
  }
  configured() {
    return Boolean(this.baseUrl);
  }
  // Cloud: メールアドレス + API トークンの Basic 認証 / Server・Data Center: 個人アクセストークンの Bearer
  auth() {
    const { JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PAT } = this.env;
    if (JIRA_EMAIL && JIRA_API_TOKEN) return `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`;
    if (JIRA_PAT) return `Bearer ${JIRA_PAT}`;
    return null;
  }
  async authenticated() {
    return Boolean(this.auth());
  }
  headers() {
    const a = this.auth();
    return { accept: 'application/json', ...(a ? { authorization: a } : {}) };
  }
  browseUrl(key) {
    return `${this.baseUrl}/browse/${key}`;
  }
  async fetchItem(r, entry, now) {
    const res = await this.http('GET', `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(r.id)}?fields=summary,status,labels,assignee,issuetype,updated`, { headers: this.headers() });
    if (!res.ok) return { ...(entry || {}), error: this.errorOf(res, now), fetchedAt: now };
    const f = (await res.json()).fields || {};
    const catKey = f.status?.statusCategory?.key;
    return ok(
      {
        title: f.summary,
        state: catKey,
        stateCategory: JIRA_CATEGORY[catKey] || 'open',
        stateLabel: f.status?.name || catKey,
        kindLabel: f.issuetype?.name || 'Jira',
        isPR: false,
        draft: false,
        labels: (f.labels || []).map((l) => ({ name: String(l), color: null })),
        assignees: f.assignee ? [f.assignee.displayName || f.assignee.name] : [],
        url: this.browseUrl(r.id),
        updatedAt: f.updated,
      },
      res,
      now,
    );
  }
  commentFormat() {
    return 'jira';
  }
  async comment(r, body) {
    if (!this.auth()) throw new Error('Jira へのコメントには JIRA_EMAIL + JIRA_API_TOKEN(Cloud)か JIRA_PAT(Server / Data Center)が必要です');
    const res = await this.http('POST', `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(r.id)}/comment`, {
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`Jira API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const j = await res.json();
    this.invalidate(r);
    return { url: j.id ? `${this.browseUrl(r.id)}?focusedCommentId=${j.id}` : this.browseUrl(r.id) };
  }
}

// ---------------------------------------------------------------- Backlog
// 標準の状態(id 1〜4)。プロジェクトで追加した状態は「進行中」とみなし、名前はそのまま表示する
const BACKLOG_STATE = { 1: 'open', 2: 'in_progress', 3: 'in_progress', 4: 'done' };

export class BacklogIssues extends CachedTracker {
  constructor({ space, ...opts } = {}) {
    super({ name: 'backlog', label: 'Backlog', ...opts });
    // "example.backlog.jp" / "example.backlog.com"(https:// は付けない)
    const s = String(space || this.env.BACKLOG_SPACE || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    this.space = /^[\w-]+\.backlog(tool)?\.(jp|com)$/.test(s) ? s : null;
  }
  itemKey(r) {
    return r.id;
  }
  valid(r) {
    return Boolean(this.space) && /^[A-Z][A-Z0-9_]{0,9}-\d{1,7}$/.test(r.id || '');
  }
  configured() {
    return Boolean(this.space);
  }
  key() {
    return this.env.BACKLOG_API_KEY || null;
  }
  async authenticated() {
    return Boolean(this.key());
  }
  base() {
    return this.env.WORKLOG_BACKLOG_API || `https://${this.space}/api/v2`;
  }
  viewUrl(key) {
    return `https://${this.space}/view/${key}`;
  }
  headers() {
    // API キーは URL に載せずヘッダーで送る(ログやプロキシに残りにくい)
    return { accept: 'application/json', ...(this.key() ? { 'backlog-api-key': this.key() } : {}) };
  }
  async fetchItem(r, entry, now) {
    if (!this.key()) return { ...(entry || {}), error: 'unauthorized', fetchedAt: now };
    const res = await this.http('GET', `${this.base()}/issues/${encodeURIComponent(r.id)}`, { headers: this.headers() });
    if (!res.ok) return { ...(entry || {}), error: this.errorOf(res, now), fetchedAt: now };
    const j = await res.json();
    return ok(
      {
        title: j.summary,
        state: j.status?.id,
        stateCategory: BACKLOG_STATE[j.status?.id] || 'in_progress',
        stateLabel: j.status?.name || '',
        kindLabel: j.issueType?.name || 'Backlog',
        isPR: false,
        draft: false,
        labels: (j.category || []).map((c) => ({ name: c.name, color: null })),
        assignees: j.assignee ? [j.assignee.name] : [],
        url: this.viewUrl(r.id),
        updatedAt: j.updated,
      },
      res,
      now,
    );
  }
  commentFormat() {
    return 'plain';
  }
  async comment(r, body) {
    if (!this.key()) throw new Error('Backlog へのコメントには BACKLOG_API_KEY が必要です');
    const res = await this.http('POST', `${this.base()}/issues/${encodeURIComponent(r.id)}/comments`, {
      headers: { ...this.headers(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ content: body }).toString(),
    });
    if (!res.ok) throw new Error(`Backlog API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const j = await res.json();
    this.invalidate(r);
    return { url: j.id ? `${this.viewUrl(r.id)}#comment-${j.id}` : this.viewUrl(r.id) };
  }
}
