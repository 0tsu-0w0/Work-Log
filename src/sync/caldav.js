// CalDAV のカレンダーへの記録(RFC 4791。Nextcloud・iCloud・Fastmail・Radicale など)。
// 予定1件 = カレンダーのコレクションの中の1つのファイル "<予定のキー>.ics"(VEVENT 1つ。中身は src/ical.js と同じ形・同じ UID)。
//   追加: PUT <コレクション>/<キー>.ics(If-None-Match: *)/ 更新: PUT(If-Match: <ETag>。ETag が返らなかったときは条件なし)/
//   削除: DELETE(If-Match: <ETag>)。応答の ETag は対応表(sync-caldav.json)に残す。
//   412(条件が合わない)のとき: 追加で起きたら同じ名前のものが既にある(対応表を消した・別の PC から記録した)/ 更新・削除で
//   起きたらカレンダーのアプリで書き換えられたか消された。どちらも Work Log の作った予定なので、今の ETag を GET で取り直し、
//   あれば上書き(削除)、無ければ作り直す。取り直した後でもまた 412 なら、止めて伝える(同時に書き換えられている)。
// 設定: CALDAV_URL(カレンダーのコレクションの URL。config.json の caldav.url でもよい)・CALDAV_USERNAME・CALDAV_PASSWORD(Basic 認証)。
//   https だけ(localhost / 127.0.0.1 は http でもよい)。リダイレクトはたどらない(認証情報を別の場所へ送らないため)ので、最終的な URL を書く。
//   Nextcloud:  https://<host>/remote.php/dav/calendars/<ユーザー>/<カレンダー>/(アプリパスワード推奨)
//   iCloud:     https://pNN-caldav.icloud.com/<数字の ID>/calendars/<カレンダーの ID>/(Apple ID とアプリ用パスワード。
//               URL は caldav.icloud.com への PROPFIND で current-user-principal → calendar-home-set をたどって調べる)
//   Fastmail:   https://caldav.fastmail.com/dav/calendars/user/<メールアドレス>/<カレンダーの ID>/(アプリパスワード)
//   Radicale:   http://localhost:5232/<ユーザー>/<カレンダー>/
// カレンダーの作り方: 記録専用のカレンダーを各サービスの画面で作るのがおすすめ。Radicale などで直接作るときは MKCALENDAR:
//   curl -u user:pass -X MKCALENDAR http://localhost:5232/user/work-log/
// 実際に確かめたもの(2026-10-05): Radicale 3.8.1(Docker の tomsquest/docker-radicale:latest、htpasswd の bcrypt 認証、owner_only)で、
//   MKCALENDAR で作ったカレンダーに `work-log sync --caldav` で追加 3件 → 2回目は追加 0件 → タイトルの変更で更新 2件 → 区間が消えたら削除 1件、
//   を PROPFIND(Depth: 1)・REPORT calendar-query(time-range)と、返った calendar-data を Python の icalendar 7.3.0 で読んで確かめた
//   (UID・SUMMARY・CATEGORIES の \ のエスケープ・METHOD が無いこと・秘匿情報が伏せてあること)。
//   412 は3通りとも実物で起こして確かめた: カレンダー側で書き換えた予定の更新(If-Match の食い違い → GET → 上書き)・
//   削除(→ GET → 削除)・対応表を消した後の追加(If-None-Match: * → GET → 上書き。重複しない)。401(パスワード違い)・409(無いカレンダー)の文面も。
//   Radicale は PUT の応答に ETag を返し、条件付きの PUT / DELETE で 412 を返す(無いものに If-Match を付けても 412)。
// 確かめていないもの: Nextcloud・iCloud・Fastmail の実物(ETag を返さない・受け取った予定を書き換えて保存するサーバーの挙動、
//   iCloud の URL の調べ方、エラー応答の文言)。
import { SyncClient } from './base.js';
import { buildEvent, eventUid } from '../ical.js';
import { mask } from '../mask.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// 応答の本文(多くは XML)を短い1行にする
const drain = (res) => res.body?.cancel().catch(() => {});
const brief = (text) => String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

export class CalDav extends SyncClient {
  constructor(opts = {}) {
    super({ name: 'caldav', label: 'CalDAV カレンダー', defaultBase: '', minIntervalMs: 200, ...opts });
  }

  rawUrl() {
    return String(this.env.CALDAV_URL || this.cfg.url || '').trim();
  }

  // カレンダーのコレクションの URL(末尾は /)。使えない URL なら null
  collection() {
    let u;
    try {
      u = new URL(this.rawUrl());
    } catch {
      return null;
    }
    if (u.username || u.password || u.search || u.hash) return null;
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))) return null;
    return u.href.endsWith('/') ? u.href : `${u.href}/`;
  }

  credentials() {
    const user = this.env.CALDAV_USERNAME || this.cfg.username;
    const pass = this.env.CALDAV_PASSWORD;
    return user && pass ? { user: String(user), pass: String(pass) } : null;
  }

  configured() {
    return Boolean(this.collection() && this.credentials());
  }

  missing() {
    const m = [];
    if (!this.rawUrl()) m.push('CALDAV_URL(または config.json の caldav.url)');
    else if (!this.collection()) m.push('CALDAV_URL(https の URL。localhost 以外の http・URL の中の認証情報は使えません)');
    if (!(this.env.CALDAV_USERNAME || this.cfg.username)) m.push('CALDAV_USERNAME');
    if (!this.env.CALDAV_PASSWORD) m.push('CALDAV_PASSWORD');
    return m;
  }

  destination() {
    const u = new URL(this.collection());
    const p = decodeURIComponent(u.pathname);
    return mask(`${u.host} ${p.length > 40 ? `…${p.slice(-38)}` : p}`);
  }

  // 対応表に残す ID はコレクションの中の名前だけ(URL を変えても、前の場所へ認証情報を送らない)
  nameOf(key) {
    return `${encodeURIComponent(key)}.ics`;
  }

  url(name) {
    if (!/^[A-Za-z0-9%._~!'()*-]+\.ics$/.test(name)) throw new Error(`CalDAV の予定の名前が不正です: ${String(name).slice(0, 40)}`);
    return this.collection() + name;
  }

  headers(extra = {}) {
    const c = this.credentials();
    return { authorization: `Basic ${Buffer.from(`${c.user}:${c.pass}`).toString('base64')}`, ...extra };
  }

  // 送る内容(hash を取るためのもの。DTSTAMP は送るときに付ける)
  payload(e) {
    return { uid: eventUid(e.key), start: e.start, end: e.end, title: e.title, description: e.description, project: e.project };
  }

  async fail(res, what) {
    const text = await res.text().catch(() => '');
    const why = {
      401: '認証に失敗しました(CALDAV_USERNAME / CALDAV_PASSWORD を確かめてください。iCloud・Fastmail はアプリ用パスワードを使います)',
      403: '書き込む権限がありません(読み取り専用のカレンダーか、URL が別の人のカレンダーです)',
      409: 'カレンダー(コレクション)が見つかりません(CALDAV_URL にカレンダーのコレクションの URL を指定してください。無ければ先に作ってください)',
    }[res.status];
    return Object.assign(new Error(`${this.label} ${res.status}(${what}): ${why || brief(text) || res.statusText}`), { status: res.status });
  }

  // 今の ETag を調べる(無ければ exists: false)
  async current(name) {
    const res = await this.send('GET', this.url(name), { headers: this.headers({ accept: 'text/calendar' }) });
    if (!res.ok && res.status !== 404 && res.status !== 410) throw await this.fail(res, '取得');
    await drain(res);
    if (res.status === 404 || res.status === 410) return { exists: false };
    return { exists: true, etag: res.headers.get('etag') || null };
  }

  async put(name, e, cond) {
    return this.send('PUT', this.url(name), {
      headers: this.headers({ 'content-type': 'text/calendar; charset=utf-8', ...cond }),
      body: buildEvent(e),
    });
  }

  // 追加・更新の共通部分。412 なら今の状態を調べて1回だけやり直す
  async write(name, e, { create = false, etag = null } = {}) {
    const what = create ? '追加' : '更新';
    let res = await this.put(name, e, create ? { 'if-none-match': '*' } : etag ? { 'if-match': etag } : {});
    if (res.status === 412) {
      await drain(res);
      const cur = await this.current(name);
      res = await this.put(name, e, !cur.exists ? { 'if-none-match': '*' } : cur.etag ? { 'if-match': cur.etag } : {});
      if (res.status === 412) throw Object.assign(new Error(`${this.label} 412(${what}): 予定が同時に書き換えられています。少し待ってからもう一度記録してください`), { status: 409 });
    }
    if (!res.ok) throw await this.fail(res, what);
    await drain(res);
    return { id: name, etag: res.headers.get('etag') || undefined };
  }

  async create(e) {
    return this.write(this.nameOf(e.key), e, { create: true });
  }

  async update(id, e, { etag } = {}) {
    return this.write(id, e, { etag });
  }

  async remove(id, { etag } = {}) {
    const del = (tag) => this.send('DELETE', this.url(id), { headers: this.headers(tag ? { 'if-match': tag } : {}) });
    let res = await del(etag);
    if (res.status === 412) {
      await drain(res);
      const cur = await this.current(id);
      if (!cur.exists) return;
      res = await del(cur.etag);
    }
    if (res.status === 404 || res.status === 410) {
      await drain(res);
      throw Object.assign(new Error(`${this.label} ${res.status}: 既にありません`), { status: res.status });
    }
    if (!res.ok) throw await this.fail(res, '削除');
    await drain(res);
  }
}
