import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NotionPages, notionUuid } from '../src/trackers/providers.js';
import { Trackers } from '../src/trackers/index.js';
import { notionRefOf, refsFromText, resolveRef, normalizeConfig } from '../src/tasks.js';
import { GitHubIssues } from '../src/github.js';
import { Store } from '../src/store.js';

const HEX = '0123456789abcdef0123456789abcdef';
const UUID = '01234567-89ab-cdef-0123-456789abcdef';
const DB = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DS = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// データソースのプロパティ定義(状態のグループと ID プロパティ)
const SCHEMA = {
  properties: {
    Name: { type: 'title' },
    ID: { type: 'unique_id', unique_id: { prefix: 'TASK' } },
    Status: {
      type: 'status',
      status: {
        options: [{ id: 's1', name: '未着手' }, { id: 's2', name: 'レビュー中' }, { id: 's3', name: '完了' }, { id: 's4', name: '中止' }],
        groups: [
          { id: 'g1', name: 'To-do', option_ids: ['s1'] },
          { id: 'g2', name: 'In progress', option_ids: ['s2'] },
          { id: 'g3', name: 'Complete', option_ids: ['s3', 's4'] },
        ],
      },
    },
  },
};

function page(statusId, statusName) {
  return {
    object: 'page',
    id: UUID,
    url: `https://www.notion.so/acme/Fix-login-${HEX}`,
    last_edited_time: '2026-10-01T00:00:00.000Z',
    parent: { type: 'data_source_id', data_source_id: DS, database_id: notionUuid(DB) },
    properties: {
      Name: { type: 'title', title: [{ plain_text: 'ログイン' }, { plain_text: 'を直す' }] },
      ID: { type: 'unique_id', unique_id: { prefix: 'TASK', number: 12 } },
      Status: { type: 'status', status: { id: statusId, name: statusName, color: 'blue' } },
      Tags: { type: 'multi_select', multi_select: [{ name: 'バグ', color: 'red' }, { name: '謎', color: 'default' }] },
      Assignee: { type: 'people', people: [{ object: 'user', name: '山田' }] },
    },
  };
}

function fake(statusId = 's2', statusName = 'レビュー中') {
  const calls = [];
  const fetchImpl = async (url, o = {}) => {
    calls.push({ url, ...o });
    const u = new URL(url);
    let body = { object: 'error', code: 'object_not_found' };
    let status = 404;
    if (u.pathname === `/v1/pages/${UUID}`) [status, body] = [200, page(statusId, statusName)];
    if (u.pathname === `/v1/databases/${notionUuid(DB)}`) [status, body] = [200, { data_sources: [{ id: DS, name: 'Tasks' }] }];
    if (u.pathname === `/v1/data_sources/${DS}`) [status, body] = [200, SCHEMA];
    if (u.pathname === `/v1/data_sources/${DS}/query`) {
      const q = JSON.parse(o.body);
      [status, body] = [200, { results: q.filter.unique_id.equals === 12 ? [page(statusId, statusName)] : [] }];
    }
    if (u.pathname === '/v1/comments') [status, body] = [200, { object: 'comment', id: 'c1' }];
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'work-log-notion-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('Notion のページURLからページIDとタイトルを読む', () => {
  assert.deepEqual(notionRefOf(`https://www.notion.so/acme/Fix-login-bug-${HEX}`), { id: `notion:${HEX}`, kind: 'notion', pageId: HEX, url: `https://www.notion.so/acme/Fix-login-bug-${HEX}`, title: 'Fix login bug' });
  assert.equal(notionRefOf(`https://www.notion.so/${HEX}?pvs=4`).title, null);
  assert.equal(notionRefOf(`https://www.notion.so/acme/${'c'.repeat(32)}?v=1&p=${HEX}&pm=s`).pageId, HEX); // データベースの一覧から開いたページ
  assert.equal(notionRefOf(`https://acme.notion.site/%E3%83%AD%E3%82%B0%E3%82%A4%E3%83%B3-${HEX}`).title, 'ログイン');
  assert.equal(notionRefOf('https://www.notion.so/acme/no-id-here'), null);
  const refs = [...refsFromText(`これを直して https://www.notion.so/acme/Fix-login-${HEX}.`, 'prompt', normalizeConfig()).values()];
  assert.deepEqual(refs.map((r) => [r.id, r.kind]), [[`notion:${HEX}`, 'notion']]);
  assert.equal(notionUuid(HEX), UUID);
  assert.equal(notionUuid('xyz'), null);
});

test('ページIDで取得し、状態をグループで分類する', async (t) => {
  const dir = await tmp(t);
  const f = fake();
  const n = new NotionPages({ cacheDir: dir, env: { NOTION_TOKEN: 'ntn_x', WORKLOG_NOTION_API: 'https://notion.example' }, fetchImpl: f.fetchImpl });
  const e = await n.getRef({ id: `notion:${HEX}`, pageId: HEX });
  assert.equal(f.calls[0].url, `https://notion.example/v1/pages/${UUID}`);
  assert.equal(f.calls[0].headers.authorization, 'Bearer ntn_x');
  assert.equal(f.calls[0].headers['notion-version'], '2025-09-03');
  assert.equal(f.calls[1].url, `https://notion.example/v1/data_sources/${DS}`); // 状態のグループを知るため
  assert.deepEqual(
    [e.data.title, e.data.kindLabel, e.data.stateLabel, e.data.stateCategory, e.data.labels, e.data.assignees, e.data.url],
    ['ログインを直す', 'TASK-12', 'レビュー中', 'in_progress', [{ name: 'バグ', color: 'e03e3e' }, { name: '謎', color: null }], ['山田'], `https://www.notion.so/acme/Fix-login-${HEX}`],
  );
  // グループが Complete でも、名前が「中止」なら中止扱い
  const g = fake('s4', '中止');
  const n2 = new NotionPages({ cacheDir: await tmp(t), env: { NOTION_TOKEN: 'x', WORKLOG_NOTION_API: 'https://notion.example' }, fetchImpl: g.fetchImpl });
  assert.equal((await n2.getRef({ pageId: HEX })).data.stateCategory, 'canceled');
  // トークンが無ければ問い合わせない
  const anon = new NotionPages({ cacheDir: dir, env: {}, fetchImpl: f.fetchImpl });
  const before = f.calls.length;
  assert.equal((await anon.getRef({ pageId: 'f'.repeat(32) })).error, 'unauthorized');
  assert.equal(f.calls.length, before);
});

test('ID プロパティ(TASK-12)でデータベースから探す', async (t) => {
  const dir = await tmp(t);
  const f = fake('s3', '完了');
  const n = new NotionPages({ cacheDir: dir, databaseId: DB, env: { NOTION_TOKEN: 'x', WORKLOG_NOTION_API: 'https://notion.example' }, fetchImpl: f.fetchImpl });
  assert.equal(n.valid({ id: 'TASK-12' }), true);
  const e = await n.getRef({ id: 'TASK-12' });
  assert.deepEqual(f.calls.map((c) => new URL(c.url).pathname), [`/v1/databases/${notionUuid(DB)}`, `/v1/data_sources/${DS}`, `/v1/data_sources/${DS}/query`]);
  assert.deepEqual(JSON.parse(f.calls[2].body), { filter: { property: 'ID', unique_id: { equals: 12 } }, page_size: 1 });
  assert.deepEqual([e.data.title, e.data.stateCategory, e.pageId], ['ログインを直す', 'done', UUID]);
  assert.equal((await n.getRef({ id: 'TASK-99' })).error, 'not_found');
  assert.equal(new NotionPages({ cacheDir: dir, env: { NOTION_TOKEN: 'x' } }).valid({ id: 'TASK-1' }), false); // データベース未設定ならキー形式は扱わない
});

test('コメントは rich_text を2000文字ずつに分けて投稿する', async (t) => {
  const dir = await tmp(t);
  const f = fake();
  const n = new NotionPages({ cacheDir: dir, databaseId: DB, env: { NOTION_TOKEN: 'x', WORKLOG_NOTION_API: 'https://notion.example' }, fetchImpl: f.fetchImpl });
  await n.getRef({ id: 'TASK-12' });
  const r = await n.comment({ id: 'TASK-12' }, 'あ'.repeat(4500));
  const post = f.calls.find((c) => new URL(c.url).pathname === '/v1/comments');
  const body = JSON.parse(post.body);
  assert.deepEqual(body.parent, { page_id: UUID });
  assert.deepEqual(body.rich_text.map((x) => x.text.content.length), [2000, 2000, 500]);
  assert.equal(r.url, `https://www.notion.so/acme/Fix-login-${HEX}`);
  await assert.rejects(new NotionPages({ cacheDir: dir, env: {} }).comment({ pageId: HEX }, 'x'), /NOTION_TOKEN/);
});

test('振り分け: Notion の URL と、設定したプレフィックス', async (t) => {
  const dir = await tmp(t);
  const cfg = normalizeConfig();
  const trk = new Trackers({ cacheDir: dir, env: { NOTION_TOKEN: 'x', LINEAR_API_KEY: 'k' }, config: { notion: { databaseId: DB, keys: ['TASK'] } } });
  assert.equal(resolveRef({ id: 'TASK-3', kind: 'key' }, { cfg, trackers: trk }).provider, 'notion');
  assert.equal(resolveRef({ id: 'TASK-3', kind: 'key', url: `https://www.notion.so/acme/x-${HEX}` }, { cfg, trackers: trk }).provider, 'notion');
  const p = resolveRef(notionRefOf(`https://www.notion.so/acme/Fix-a-very-long-title-for-the-login-page-${HEX}`), { cfg, trackers: trk });
  assert.deepEqual([p.provider, p.label], ['notion', 'Fix a very long title for the …']);
  // Notion だけ設定してあれば、プレフィックスの指定が無くても Notion に振り分ける
  const only = new Trackers({ cacheDir: dir, env: { NOTION_TOKEN: 'x' }, config: { notion: { databaseId: DB } } });
  assert.equal(resolveRef({ id: 'DOC-1', kind: 'key' }, { cfg, trackers: only }).provider, 'notion');
});

test('ストア経由: 依頼文の Notion URL をタスクにし、ページの情報を付ける', async (t) => {
  const root = await tmp(t);
  const proj = path.join(root, 'projects', '-x');
  await mkdir(proj, { recursive: true });
  const line = (o) => JSON.stringify({ sessionId: 's', cwd: '/nonexistent/x', ...o });
  await writeFile(path.join(proj, 's1.jsonl'), [
    line({ type: 'user', timestamp: '2026-10-01T01:00:00Z', message: { role: 'user', content: `https://www.notion.so/acme/Fix-login-${HEX} を対応して` } }),
    line({ type: 'assistant', timestamp: '2026-10-01T01:30:00Z', message: { id: 'a', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [] } }),
  ].join('\n'));
  const f = fake();
  const store = new Store({ projectsDir: path.join(root, 'projects'), cacheDir: path.join(root, 'cache'), github: new GitHubIssues({ cacheDir: path.join(root, 'cache'), env: {}, tokenProvider: async () => null }) });
  store.trackers.env = { NOTION_TOKEN: 'x', WORKLOG_NOTION_API: 'https://notion.example' };
  store.trackers.fetchImpl = f.fetchImpl;
  await store.scan();
  const [task] = await store.tasks({});
  assert.deepEqual([task.provider, task.label, task.issue.title, task.issue.stateLabel], ['notion', 'Fix login', 'ログインを直す', 'レビュー中']);
  const c = await store.issueComment(task.id, { timeZone: 'UTC' });
  assert.deepEqual([c.provider, c.authenticated], ['notion', true]);
  assert.match(c.body, /^■ 作業記録/);
  await store.postIssueComment(task.id, c.hash, { timeZone: 'UTC' });
  assert.deepEqual(JSON.parse(f.calls.at(-1).body).parent, { page_id: UUID });
});
