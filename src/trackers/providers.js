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

// ---------------------------------------------------------------- Notion
// API の形は公式 SDK(@notionhq/client)に合わせている: Notion-Version 2025-09-03、Bearer 認証、
// データベースは data_sources を通して問い合わせる(ID プロパティは unique_id フィルターの equals で探す)、
// 状態のグループは data source の status.groups[].option_ids、コメントは POST /v1/comments(parent.page_id + rich_text)
const NOTION_VERSION = '2025-09-03';
const NOTION_COLORS = { gray: '9b9a97', brown: '937264', orange: 'd9730d', yellow: 'dfab01', green: '0f7b6c', blue: '0b6e99', purple: '6940a5', pink: 'ad1a72', red: 'e03e3e' };
const SCHEMA_TTL_MS = 60 * 60 * 1000;

// "0123abcd…"(32桁)を Notion の UUID 表記にそろえる
export function notionUuid(hex) {
  const h = String(hex || '').replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(h) ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : null;
}

// 状態のグループ名から分類する。既定のグループは To-do / In progress / Complete。名前に「中止」などがあれば中止扱い
function notionCategory(group, name) {
  if (/cancel|中止|見送|取り下げ|won'?t/i.test(name || '')) return 'canceled';
  const g = String(group || '').toLowerCase();
  if (/complete|done|完了/.test(g)) return 'done';
  if (/progress|進行|対応中/.test(g)) return 'in_progress';
  if (group) return 'open';
  if (/done|complete|完了|済/i.test(name || '')) return 'done';
  if (/progress|進行|対応中|review|レビュー/i.test(name || '')) return 'in_progress';
  return 'open';
}

export class NotionPages extends CachedTracker {
  constructor({ databaseId, dataSourceId, idProperty, keys, ...opts } = {}) {
    super({ name: 'notion', label: 'Notion', ...opts });
    this.apiBase = (this.env.WORKLOG_NOTION_API || 'https://api.notion.com').replace(/\/+$/, '');
    this.databaseId = notionUuid(databaseId || this.env.NOTION_DATABASE_ID);
    this.dataSourceId = notionUuid(dataSourceId || this.env.NOTION_DATA_SOURCE_ID);
    this.idProperty = idProperty || null;
    this.schemas = new Map(); // data source id -> { at, promise }
  }
  // ページURLから来たものはページID、ID プロパティ(TASK-12 など)から来たものはその ID で覚える
  itemKey(r) {
    return r.pageId || r.id;
  }
  valid(r) {
    if (r.pageId) return Boolean(notionUuid(r.pageId));
    return Boolean(this.databaseId || this.dataSourceId) && /^[A-Z][A-Z0-9_]{0,9}-\d{1,7}$/.test(r.id || '');
  }
  configured() {
    return Boolean(this.token() && (this.databaseId || this.dataSourceId));
  }
  token() {
    return this.env.NOTION_TOKEN || this.env.NOTION_API_KEY || null;
  }
  async authenticated() {
    return Boolean(this.token());
  }
  headers() {
    return { authorization: `Bearer ${this.token()}`, 'notion-version': NOTION_VERSION, accept: 'application/json' };
  }
  api(method, p, body) {
    return this.http(method, `${this.apiBase}/v1/${p}`, {
      headers: { ...this.headers(), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  // データベースのIDしか分からないときは、最初の data source を使う
  async dataSource() {
    if (this.dataSourceId) return this.dataSourceId;
    if (!this.databaseId) return null;
    const res = await this.api('GET', `databases/${this.databaseId}`);
    if (!res.ok) return null;
    this.dataSourceId = (await res.json()).data_sources?.[0]?.id || null;
    return this.dataSourceId;
  }

  // data source のプロパティ定義(状態のグループ、ID プロパティの接頭辞)。1時間使い回す
  schema(dsId, now = Date.now()) {
    const hit = this.schemas.get(dsId);
    if (hit && now - hit.at < SCHEMA_TTL_MS) return hit.promise;
    const promise = this.api('GET', `data_sources/${dsId}`).then(async (res) => (res.ok ? (await res.json()).properties || {} : {}), () => ({}));
    this.schemas.set(dsId, { at: now, promise });
    return promise;
  }

  // "TASK-12" を、ID プロパティ(unique_id)で探してページIDにする
  async findByUniqueId(id) {
    const ds = await this.dataSource();
    if (!ds) return { error: 'not_found' };
    const [prefix, num] = [id.split('-')[0], Number(id.split('-').pop())];
    const props = await this.schema(ds);
    const prop =
      this.idProperty ||
      Object.entries(props).find(([, v]) => v.type === 'unique_id' && (v.unique_id?.prefix || '').toUpperCase() === prefix)?.[0] ||
      Object.entries(props).find(([, v]) => v.type === 'unique_id')?.[0];
    if (!prop) return { error: 'not_found' };
    const res = await this.api('POST', `data_sources/${ds}/query`, { filter: { property: prop, unique_id: { equals: num } }, page_size: 1 });
    if (!res.ok) return { res };
    const page = (await res.json()).results?.[0];
    return page ? { page } : { error: 'not_found' };
  }

  async fetchItem(r, entry, now) {
    if (!this.token()) return { ...(entry || {}), error: 'unauthorized', fetchedAt: now };
    let page;
    if (r.pageId) {
      const res = await this.api('GET', `pages/${notionUuid(r.pageId)}`);
      if (!res.ok) return { ...(entry || {}), error: this.errorOf(res, now), fetchedAt: now };
      page = await res.json();
    } else {
      const found = await this.findByUniqueId(r.id);
      if (found.res) return { ...(entry || {}), error: this.errorOf(found.res, now), fetchedAt: now };
      if (found.error) return { ...(entry || {}), error: found.error, fetchedAt: now };
      page = found.page;
    }
    const props = Object.values(page.properties || {});
    const title = (props.find((p) => p.type === 'title')?.title || []).map((t) => t.plain_text).join('') || '(無題)';
    const status = props.find((p) => p.type === 'status')?.status || props.find((p) => p.type === 'select' && p.select)?.select || null;
    let group = null;
    const dsId = page.parent?.data_source_id;
    if (status && dsId) {
      const schema = await this.schema(dsId, now);
      for (const def of Object.values(schema)) {
        const g = def.type === 'status' ? (def.status?.groups || []).find((x) => (x.option_ids || []).includes(status.id)) : null;
        if (g) group = g.name;
      }
    }
    const uid = props.find((p) => p.type === 'unique_id')?.unique_id;
    const labels = props.find((p) => p.type === 'multi_select')?.multi_select || [];
    const people = props.find((p) => p.type === 'people')?.people || [];
    return {
      fetchedAt: now,
      pageId: page.id,
      data: {
        title,
        state: status?.name || null,
        stateCategory: status ? notionCategory(group, status.name) : 'open',
        stateLabel: status?.name || '',
        kindLabel: uid?.number != null ? `${uid.prefix ? `${uid.prefix}-` : ''}${uid.number}` : 'Page',
        isPR: false,
        draft: false,
        labels: labels.map((l) => ({ name: l.name, color: NOTION_COLORS[l.color] || null })),
        assignees: people.map((u) => u.name).filter(Boolean),
        url: page.url,
        updatedAt: page.last_edited_time,
      },
    };
  }

  commentFormat() {
    return 'plain';
  }

  // rich_text の1要素は2000文字までなので分けて送る
  async comment(r, body) {
    if (!this.token()) throw new Error('Notion へのコメントには NOTION_TOKEN(インテグレーションのシークレット)が必要です');
    let pageId = r.pageId ? notionUuid(r.pageId) : this.cache[this.itemKey(r)]?.pageId;
    if (!pageId) {
      const found = await this.findByUniqueId(r.id);
      pageId = found.page?.id;
    }
    if (!pageId) throw new Error('Notion のページが見つかりません');
    const chunks = [];
    for (let i = 0; i < body.length; i += 2000) chunks.push({ type: 'text', text: { content: body.slice(i, i + 2000) } });
    const res = await this.api('POST', 'comments', { parent: { page_id: pageId }, rich_text: chunks });
    if (!res.ok) throw new Error(`Notion API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    this.invalidate(r);
    return { url: this.cache[this.itemKey(r)]?.data?.url || null };
  }
}
