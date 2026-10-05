// 手元の PC で動かしたまま、スマホなど自分の別の端末から Tailscale 経由で開くための設定。
// サーバーは 127.0.0.1 でだけ待ち受けたままにし、`tailscale serve` に HTTPS で中継させる
// (https://<PC の名前>.<tailnet>.ts.net/ → http://127.0.0.1:<port>)。インターネットには出さない。
//
// tailscale v1.102.5 のソース(ipn/ipnlocal/serve.go)で確かめたこと:
//   - 中継先には Host をそのまま渡す(r.Out.Host = r.In.Host)。そのため Host に ts.net の名前を許す必要がある
//   - 中継の前に、送り手が付けた Tailscale-User-Login / Tailscale-Funnel-Request などを消してから付け直す。
//     tailnet の利用者からの要求には Tailscale-User-Login(MIME の Q 符号化)を、
//     Funnel(インターネット公開)経由の要求には Tailscale-Funnel-Request: ?1 を付ける
//   - `tailscale serve --bg <port>` は既定で HTTPS 443 番、止めるのは `tailscale serve --https=443 off`
//   - `tailscale status --json` の Self.DNSName(末尾にドット)、Self.UserID、User[ID].LoginName、BackendState
// 本物の tailnet へのログインはできない環境のため、実際に中継させての確認はしていない(ログイン前の status --json と serve の応答は確認済み)。
import { execFile } from 'node:child_process';

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

// config.json の remote: { hosts: ["mypc.tail1234.ts.net"], users: ["me@example.com"] }
export function normalizeRemote(cfg = {}, env = {}) {
  const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const hosts = [...new Set([...list(cfg?.hosts), ...list(env.WORKLOG_REMOTE_HOSTS)])].filter((h) => /^[a-z0-9.-]+$/.test(h) && !LOCAL_HOSTS.includes(h));
  const users = [...new Set([...list(cfg?.users), ...list(env.WORKLOG_REMOTE_USERS)])];
  return { hosts, users };
}

// Tailscale が付ける値は MIME の Q 符号化(=?utf-8?q?...?=)のことがある
export function decodeHeaderValue(v) {
  const s = String(v ?? '');
  const m = /^=\?utf-8\?q\?(.*)\?=$/i.exec(s);
  if (!m) return s;
  const bytes = [];
  for (let i = 0; i < m[1].length; i++) {
    const c = m[1][i];
    if (c === '_') bytes.push(0x20);
    else if (c === '=' && /^[0-9a-f]{2}$/i.test(m[1].slice(i + 1, i + 3))) {
      bytes.push(parseInt(m[1].slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(c.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

// 要求を受けてよいか。{ ok, remote, status, error }
//   手元(127.0.0.1 / localhost)は今まで通り。Tailscale の名前は、設定したものだけ・Funnel 経由は断る・
//   利用者を決めていればその人だけ・書き込みは https://<その名前> からのページだけ
export function checkAccess(req, remote) {
  const hostHeader = String(req.headers.host || '').toLowerCase();
  const host = hostHeader.replace(/:\d+$/, '');
  const write = req.method !== 'GET' && req.method !== 'HEAD';
  const origin = req.headers.origin;
  if (LOCAL_HOSTS.includes(host)) {
    // 他のサイトのページからの書き込み(CSRF)を断る。フックからの通知は Origin を付けないので通る
    if (write && origin && origin !== `http://${req.headers.host}`) return { ok: false, status: 403, error: 'forbidden origin' };
    return { ok: true, remote: false };
  }
  // DNS リバインディング対策: 知らない Host には応じない
  if (!remote.hosts.includes(host)) return { ok: false, status: 403, error: 'forbidden host' };
  if (req.headers['tailscale-funnel-request']) return { ok: false, status: 403, error: 'Funnel(インターネット公開)経由では開けません' };
  if (remote.users.length) {
    const login = decodeHeaderValue(req.headers['tailscale-user-login']).toLowerCase();
    if (!login || !remote.users.includes(login)) return { ok: false, status: 403, error: 'この Tailscale の利用者には許可していません' };
  }
  if (write && origin !== `https://${host}`) return { ok: false, status: 403, error: 'forbidden origin' };
  return { ok: true, remote: true };
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') return reject(new Error('tailscale コマンドが見つかりません。Tailscale をインストールしてログインしてください(https://tailscale.com/download)'));
        return reject(new Error(`tailscale ${args.join(' ')} に失敗しました: ${(stderr || err.message).trim().slice(0, 300)}`));
      }
      resolve(stdout);
    });
  });
}

const tailscaleBin = (env) => env.WORKLOG_TAILSCALE_BIN || 'tailscale';

// この PC の tailnet での名前と、ログインしている利用者
export async function tailscaleSelf(env = process.env) {
  const st = JSON.parse(await run(tailscaleBin(env), ['status', '--json']));
  if (st.BackendState !== 'Running') throw new Error(`Tailscale がつながっていません(状態: ${st.BackendState || '不明'})。tailscale up でログインしてください`);
  const host = String(st.Self?.DNSName || '').replace(/\.$/, '').toLowerCase();
  if (!host) throw new Error('この PC の Tailscale の名前(MagicDNS)が分かりません。管理画面で MagicDNS と HTTPS 証明書を有効にしてください');
  const login = st.User?.[String(st.Self?.UserID)]?.LoginName || null;
  return { host, login: login ? login.toLowerCase() : null };
}

export const serveOn = (port, env = process.env) => run(tailscaleBin(env), ['serve', '--bg', '--yes', String(port)]);
export const serveOff = (env = process.env) => run(tailscaleBin(env), ['serve', '--https=443', 'off']);

// config.json の remote を書き換える(ほかの設定はそのまま残す)。読めない config.json は上書きしない
export async function updateRemoteConfig(cacheDir, fn) {
  const { readFile, writeFile, mkdir, rename } = await import('node:fs/promises');
  const path = await import('node:path');
  const file = path.join(cacheDir, 'config.json');
  let json = {};
  try {
    json = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`${file} を読めないので書き換えません: ${err.message}`);
  }
  json.remote = fn(normalizeRemote(json.remote));
  await mkdir(cacheDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(json, null, 2) + '\n');
  await rename(tmp, file);
  return { file, remote: json.remote };
}
