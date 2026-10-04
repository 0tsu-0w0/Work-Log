import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { sessionGit, webBaseFromRemote, commitUrl, parseLog } from '../src/git.js';

function sh(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' }).trim();
}

let n = 0;
async function commit(repo, date, subject, { name = 'Me', email = 'me@example.com' } = {}) {
  await writeFile(path.join(repo, `f${n++}.txt`), 'a\nb\n');
  sh(repo, ['add', '-A']);
  sh(repo, ['commit', '-q', '-m', subject], {
    GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
  });
  return sh(repo, ['rev-parse', 'HEAD']);
}

async function makeRepo(t) {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'work-log-git-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  sh(repo, ['init', '-q', '-b', 'main']);
  sh(repo, ['config', 'user.email', 'me@example.com']);
  sh(repo, ['config', 'user.name', 'Me']);
  sh(repo, ['config', 'commit.gpgsign', 'false']);
  sh(repo, ['remote', 'add', 'origin', 'git@github.com:dev/myapp.git']);
  return repo;
}

const SEGMENTS = [
  { start: '2026-09-28T01:00:00Z', end: '2026-09-28T01:30:00Z' },
  { start: '2026-09-28T03:00:00Z', end: '2026-09-28T03:20:00Z' },
];

test('Claudeのコミットと同時間帯の自分のコミットを紐付ける', async (t) => {
  const repo = await makeRepo(t);
  const before = await commit(repo, '2026-09-28T00:30:00Z', '前日の作業'); // 区間の外
  const byClaude = await commit(repo, '2026-09-28T01:10:00Z', 'fix login');
  const manual = await commit(repo, '2026-09-28T01:35:00Z', '手で直した'); // 区間の終わりから5分後
  await commit(repo, '2026-09-28T01:20:00Z', '同僚のコミット', { name: 'Other', email: 'other@example.com' });
  await commit(repo, '2026-09-28T02:15:00Z', '休憩中'); // 区間の間
  const rewrittenLater = await commit(repo, '2026-09-29T09:00:00Z', 'あとで日付が変わった');

  const session = {
    cwd: path.join(repo), // サブディレクトリでもよい
    segments: SEGMENTS,
    status: 'done',
    commitList: [
      { hash: byClaude.slice(0, 7), subject: 'fix login' },
      { hash: rewrittenLater.slice(0, 7), subject: 'あとで日付が変わった' },
      { hash: 'deadbee', subject: 'amend で消えた' },
    ],
  };
  const g = await sessionGit(session);
  assert.equal(g.available, true);
  assert.equal(g.webBase, 'https://github.com/dev/myapp');
  const got = g.commits.map((c) => [c.subject, c.source]);
  assert.deepEqual(got, [
    ['fix login', 'claude'],
    ['手で直した', 'time'],
    ['あとで日付が変わった', 'claude'],
  ]);
  assert.ok(!g.commits.some((c) => c.hash === before));
  assert.equal(g.commits.find((c) => c.hash === manual).url, `https://github.com/dev/myapp/commit/${manual}`);
  assert.deepEqual(g.missing.map((c) => c.hash), ['deadbee']);
  assert.deepEqual(g.totals, { commits: 3, insertions: 6, deletions: 0, files: 3 });
  assert.equal(g.commits[0].email, undefined); // 作者のメールアドレスは返さない
});

test('-q のコミットは実行時刻の近いコミットを Claude のものとみなす', async (t) => {
  const repo = await makeRepo(t);
  await commit(repo, '2026-09-28T01:05:00Z', 'quiet');
  await commit(repo, '2026-09-28T01:20:00Z', 'manual');
  const g = await sessionGit({ cwd: repo, segments: SEGMENTS, status: 'done', commitList: [], quietCommits: ['2026-09-28T01:05:03Z'] });
  assert.deepEqual(g.commits.map((c) => [c.subject, c.source]), [['quiet', 'claude'], ['manual', 'time']]);
});

test('作業中のセッションは現在時刻までを対象にする', async (t) => {
  const repo = await makeRepo(t);
  await commit(repo, '2026-09-28T05:00:00Z', 'さっきのコミット');
  const session = { cwd: repo, segments: SEGMENTS, status: 'working', commitList: [] };
  const done = await sessionGit({ ...session, status: 'done' });
  assert.equal(done.commits.length, 0);
  const working = await sessionGit(session, { now: Date.parse('2026-09-28T05:01:00Z') });
  assert.equal(working.commits.length, 1);
});

test('リポジトリでない場所・存在しない場所', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'work-log-nogit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await sessionGit({ cwd: dir, segments: SEGMENTS }), { available: false, reason: 'not-repo' });
  assert.equal((await sessionGit({ cwd: path.join(dir, 'gone'), segments: SEGMENTS })).available, false);
  assert.equal((await sessionGit({ cwd: null, segments: SEGMENTS })).reason, 'no-cwd');
});

test('コミットの無い空のリポジトリ', async (t) => {
  const repo = await makeRepo(t);
  const g = await sessionGit({ cwd: repo, segments: SEGMENTS, commitList: [{ hash: 'abcdef1', subject: 'x' }] });
  assert.equal(g.available, true);
  assert.deepEqual(g.commits, []);
  assert.equal(g.missing.length, 1);
});

test('リモートURLからWebのURLを作る', () => {
  assert.equal(webBaseFromRemote('git@github.com:dev/app.git'), 'https://github.com/dev/app');
  assert.equal(webBaseFromRemote('https://github.com/dev/app.git'), 'https://github.com/dev/app');
  assert.equal(webBaseFromRemote('https://user:ghp_secret@github.com/dev/app'), 'https://github.com/dev/app');
  assert.equal(webBaseFromRemote('ssh://git@gitlab.com:2222/grp/sub/app.git'), 'https://gitlab.com/grp/sub/app');
  assert.equal(webBaseFromRemote('/srv/repos/app.git'), null);
  assert.equal(webBaseFromRemote(''), null);
  assert.equal(commitUrl('https://gitlab.com/g/a', 'abc'), 'https://gitlab.com/g/a/-/commit/abc');
  assert.equal(commitUrl('https://bitbucket.org/g/a', 'abc'), 'https://bitbucket.org/g/a/commits/abc');
  assert.equal(commitUrl(null, 'abc'), null);
});

test('git log の出力を読む(バイナリ・ファイル名の空白)', () => {
  const out = '\x1eabc\x1fab\x1fMe\x1fme@x\x1f2026-09-28T01:00:00Z\x1f2026-09-28T01:00:00Z\x1fsubj\n\n3\t1\tsrc/a b.ts\n-\t-\timg.png\n';
  assert.deepEqual(parseLog(out), [{
    hash: 'abc', short: 'ab', author: 'Me', email: 'me@x', authorDate: '2026-09-28T01:00:00Z', commitDate: '2026-09-28T01:00:00Z',
    subject: 'subj', insertions: 3, deletions: 1, files: ['src/a b.ts', 'img.png'],
  }]);
});
