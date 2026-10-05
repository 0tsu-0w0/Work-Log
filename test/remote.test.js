import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAccess, normalizeRemote, decodeHeaderValue, tailscaleSelf } from '../src/remote.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

const HOST = 'mypc.tail1234.ts.net';
const remote = normalizeRemote({ hosts: [HOST], users: ['me@example.com'] });
const req = (headers, method = 'GET') => ({ method, headers });

test('手元からの要求は今まで通り、知らない Host は断る', () => {
  const open = normalizeRemote({ hosts: [HOST] });
  assert.equal(checkAccess(req({ host: '127.0.0.1:4317' }), open).ok, true);
  assert.equal(checkAccess(req({ host: 'localhost:4317', origin: 'http://localhost:4317' }, 'POST'), open).ok, true);
  assert.equal(checkAccess(req({ host: '127.0.0.1:4317', origin: 'https://evil.example' }, 'POST'), open).error, 'forbidden origin');
  assert.equal(checkAccess(req({ host: 'evil.example' }), open).error, 'forbidden host');
  // 設定が無ければ Tailscale の名前でも断る
  assert.equal(checkAccess(req({ host: HOST }), normalizeRemote({})).error, 'forbidden host');
  // 変な名前や手元の名前は設定に入れても無視する
  assert.deepEqual(normalizeRemote({ hosts: ['localhost', 'a b', 'MyPC.ts.net'] }).hosts, ['mypc.ts.net']);
});

test('Tailscale 経由: 設定した名前・利用者だけ、Funnel は断る、書き込みは https の自分のページから', () => {
  const login = { host: HOST, 'tailscale-user-login': 'me@example.com' };
  assert.deepEqual(checkAccess(req(login), remote), { ok: true, remote: true });
  assert.match(checkAccess(req({ ...login, 'tailscale-funnel-request': '?1' }), remote).error, /Funnel/);
  assert.match(checkAccess(req({ host: HOST, 'tailscale-user-login': 'other@example.com' }), remote).error, /許可していません/);
  assert.match(checkAccess(req({ host: HOST }), remote).error, /許可していません/); // タグ付きの端末など、利用者が分からない
  assert.equal(checkAccess(req({ ...login, origin: `https://${HOST}` }, 'POST'), remote).ok, true);
  assert.equal(checkAccess(req({ ...login, origin: `http://${HOST}` }, 'POST'), remote).error, 'forbidden origin');
  assert.equal(checkAccess(req(login, 'POST'), remote).error, 'forbidden origin');
  // 利用者を決めていなければ tailnet の誰でも
  assert.equal(checkAccess(req({ host: HOST }), normalizeRemote({ hosts: [HOST] })).ok, true);
});

test('Tailscale の Q 符号化された利用者名を戻す', () => {
  assert.equal(decodeHeaderValue('me@example.com'), 'me@example.com');
  assert.equal(decodeHeaderValue('=?utf-8?q?=E5=B1=B1=E7=94=B0_=E5=A4=AA=E9=83=8E?='), '山田 太郎');
  assert.equal(checkAccess(req({ host: HOST, 'tailscale-user-login': '=?utf-8?q?me@example.com?=' }), remote).ok, true);
});

function call(port, { method = 'GET', path: p = '/api/config', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
    r.end(method === 'POST' ? '{}' : undefined);
  });
}

test('サーバー: config.json の remote に従って Tailscale の名前で開ける。フックの受け口と指標は手元だけ', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-log-remote-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'cache'), { recursive: true });
  await writeFile(path.join(root, 'cache', 'config.json'), JSON.stringify({ remote: { hosts: [HOST], users: ['me@example.com'] } }));
  const store = new Store({ projectsDir: path.join(root, 'none'), cacheDir: path.join(root, 'cache') });
  await store.scan();
  const server = createServer(store, { env: { WORKLOG_METRICS: '1' } });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
  });
  const port = server.address().port;
  const me = { host: HOST, 'tailscale-user-login': 'me@example.com' };
  assert.equal((await call(port, { headers: me })).status, 200);
  assert.equal((await call(port, { path: '/', headers: me })).status, 200);
  assert.equal((await call(port, { headers: { host: HOST, 'tailscale-user-login': 'x@example.com' } })).status, 403);
  assert.equal((await call(port, { headers: { host: 'other.tail1234.ts.net', 'tailscale-user-login': 'me@example.com' } })).status, 403);
  assert.equal((await call(port, { path: '/metrics', headers: me })).status, 403);
  assert.equal((await call(port, { method: 'POST', path: '/api/hook', headers: { ...me, origin: `https://${HOST}` } })).status, 403);
  // 手元からは今まで通り
  assert.equal((await call(port, { path: '/metrics', headers: { host: `127.0.0.1:${port}` } })).status, 200);
  assert.equal((await call(port, { method: 'POST', path: '/api/rescan', headers: { host: `127.0.0.1:${port}` } })).status, 200);
});

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const runCli = (args, env) =>
  new Promise((resolve) => execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));

// tailscale コマンドの代わり。status --json は実際の tailscale 1.102.5 の出力の形(必要な項目だけ)
async function fakeTailscale(dir, status) {
  const log = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'tailscale');
  await writeFile(path.join(dir, 'status.json'), JSON.stringify(status));
  await writeFile(bin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nif [ "$1" = status ]; then cat ${JSON.stringify(path.join(dir, 'status.json'))}; fi\n`);
  await chmod(bin, 0o755);
  return { bin, log };
}

const RUNNING = {
  Version: '1.102.5-1-t5fb2a81b0', BackendState: 'Running',
  Self: { HostName: 'mypc', DNSName: `${HOST}.`, OS: 'linux', UserID: 12345, Online: true },
  User: { 12345: { ID: 12345, LoginName: 'Me@Example.com', DisplayName: 'Me' } },
  CurrentTailnet: { Name: 'me@example.com', MagicDNSSuffix: 'tail1234.ts.net' },
};

test('work-log remote setup / status / off(tailscale は差し替え)', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-log-remote-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = path.join(root, 'cache');
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, 'config.json'), JSON.stringify({ slack: { notify: 'session_end' } }));
  const ts = await fakeTailscale(root, RUNNING);
  const env = { WORKLOG_CACHE_DIR: cache, WORKLOG_TAILSCALE_BIN: ts.bin, WORKLOG_PROJECTS_DIR: path.join(root, 'none') };
  const r = await runCli(['remote', 'setup', '--port', '4400'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`https://${HOST.replace(/\./g, '\\.')}/`));
  const cfg = JSON.parse(await readFile(path.join(cache, 'config.json'), 'utf8'));
  assert.deepEqual(cfg, { slack: { notify: 'session_end' }, remote: { hosts: [HOST], users: ['me@example.com'] } }); // ほかの設定は残す
  assert.match(await readFile(ts.log, 'utf8'), /^status --json\nserve --bg --yes 4400\n$/);
  assert.match((await runCli(['remote', 'status'], env)).stdout, /me@example\.com/);
  const off = await runCli(['remote', 'off'], env);
  assert.equal(off.code, 0, off.stderr);
  assert.match(await readFile(ts.log, 'utf8'), /serve --https=443 off\n$/);
  assert.deepEqual(JSON.parse(await readFile(path.join(cache, 'config.json'), 'utf8')).remote, { hosts: [], users: [] });
});

test('Tailscale にログインしていなければ、理由を伝えて何も変えない', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-log-remote-ng-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // ログイン前の tailscaled の実際の応答(BackendState: NeedsLogin、DNSName は空)
  const ts = await fakeTailscale(root, { Version: '1.102.5-1-t5fb2a81b0', BackendState: 'NeedsLogin', Self: { HostName: '685484b33c74', DNSName: '', UserID: 0 } });
  await assert.rejects(tailscaleSelf({ WORKLOG_TAILSCALE_BIN: ts.bin }), /NeedsLogin.*tailscale up/);
  await assert.rejects(tailscaleSelf({ WORKLOG_TAILSCALE_BIN: path.join(root, 'none') }), /インストール/);
});
