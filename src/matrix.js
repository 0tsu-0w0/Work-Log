// Matrix への送信(Client-Server API)。
//   PUT {MATRIX_HOMESERVER}/_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}
//   Authorization: Bearer {MATRIX_ACCESS_TOKEN}
//   本文: { msgtype, body, format: 'org.matrix.custom.html', formatted_body, 'm.mentions': {} }
// MATRIX_HOMESERVER は https の URL(http は localhost / 127.0.0.1 / ::1 だけ)。ルームは MATRIX_ROOM_ID か config.json の matrix.roomId(!で始まるルーム ID。#別名は使えない)。
// msgtype は既定で m.notice(自動で送る投稿向けの種類。既定のプッシュ規則 .m.rule.suppress_notices で通知も未読の数も増えない)。
// 普通の発言と同じく未読として数えてほしいときは、config.json の matrix.msgtype を "m.text" にする(それでもメンションにはならない)。
// "m.mentions": {} は「この投稿は誰にもメンションしない」という宣言(intentional mentions、Matrix 1.7)。これがあると、
// 本文に @room や表示名が含まれても、本文の文字列から通知を決める古い規則(.m.rule.contains_display_name / .m.rule.roomnotif など)は働かない。
// 古いクライアント向けに、本文の @ も report.js で全角にしている。txnId は送るたびに新しく作り、429(M_LIMIT_EXCEEDED)で
// 待ってから送り直すときは同じ txnId を使う(サーバーが同じ送信として扱うので二重に投稿されない)。
// 応答の event_id から https://matrix.to/#/{roomId}/{eventId} を返す。アクセストークンはサーバー側だけで使い、status() には出さない。
//
// 実サーバーで確かめたこと(2026-10-05、Docker の matrixdotorg/synapse 1.162.0、server_name=localhost、既定のルーム v12):
//   - 送り手・bob・carol を register_new_matrix_user で登録し、3人のルームを作って招待・参加させ、
//     `work-log report --matrix` でタイトルに "@room" と "@bob:localhost" を含む日報を送った(ルーム ID はサーバー名の無い v12 の形)。
//   - bob の /messages で、formatted_body(h3・h4・ul・li、< > & は実体参照)、m.mentions が空のオブジェクト、本文の @ が ＠ になっていることを確かめた。
//   - bob の /sync の unread_notifications と /notifications(?only=highlight も): 既定の m.notice の日報では notification_count も
//     highlight_count も増えない。m.text にしても highlight_count は増えない(notification_count は普通の発言と同じく1増える)。
//     対照として、m.mentions の無い同じ本文(古い規則 .m.rule.roomnotif / contains_display_name)と本物のメンション
//     (m.mentions.user_ids)ではハイライトが増え、同じ本文に m.mentions: {} を付けると増えないことを確かめた。
//   - rc_message を厳しくした設定で実際の 429 M_LIMIT_EXCEEDED(retry_after_ms: 768 など)を起こし、待ってから同じ txnId で送り直し、
//     8件続けて送っても二重にならず8件だけ投稿されること。
//   - 間違ったトークン(401 M_UNKNOWN_TOKEN)と参加していないルーム(403 M_FORBIDDEN)のエラー。セッション終了の通知。
// 確かめていないこと: Element など実際のクライアントでの表示(HTML は Synapse に保存された形だけを確かめた)、
//   matrix.org など公開のホームサーバー、https のホームサーバー(手元の http://localhost だけ)、
//   暗号化されたルーム(暗号化はしないので、暗号化ルームには送らないこと)、サーバー名の付いた古い形のルーム ID(偽のサーバーのテストのみ)。
import { randomBytes } from 'node:crypto';

const TIMEOUT_MS = 10000;
const MAX_WAIT_MS = 10000; // 429 で待つのはここまで(これより長いならエラーにする)
const RETRIES = 2;
const ROOM_RE = /^![A-Za-z0-9._~+/=-]+(?::[A-Za-z0-9.-]+(?::\d+)?|:\[[0-9A-Fa-f:.]+\](?::\d+)?)?$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Matrix {
  constructor({ env = process.env, fetchImpl = fetch, config = {}, sleepImpl = sleep } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.setConfig(config);
  }

  setConfig(cfg = {}) {
    this.cfg = cfg && typeof cfg === 'object' ? cfg : {};
  }

  homeserver() {
    const u = this.env.MATRIX_HOMESERVER;
    if (!u) return null;
    let url;
    try {
      url = new URL(u);
    } catch {
      return null;
    }
    if (url.username || url.password || url.search || url.hash) return null;
    const ok = url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    return ok ? url.origin + url.pathname.replace(/\/+$/, '') : null;
  }

  roomId() {
    const r = String(this.cfg.roomId || this.env.MATRIX_ROOM_ID || '').trim();
    return ROOM_RE.test(r) ? r : null;
  }

  token() {
    const t = this.env.MATRIX_ACCESS_TOKEN;
    return t && /^[\x21-\x7e]+$/.test(t) ? t : null;
  }

  status() {
    const hs = this.homeserver();
    const ok = Boolean(hs && this.roomId() && this.token());
    return {
      configured: ok,
      mode: ok ? 'client-server' : null,
      destination: ok ? `${new URL(hs).host} ${this.roomId()}` : null, // トークンは出さない
      includeCost: Boolean(this.cfg.includeCost),
      notify: this.cfg.notify === 'session_end' ? 'session_end' : null,
    };
  }

  // message: { body, formatted_body }(report.js の toMatrix / sessionEndMatrix)
  async post({ body, formatted_body }) {
    const hs = this.homeserver();
    const room = this.roomId();
    const token = this.token();
    if (!hs || !room || !token) throw new Error('Matrix の送り先が設定されていません(MATRIX_HOMESERVER・MATRIX_ACCESS_TOKEN・MATRIX_ROOM_ID)');
    const content = {
      msgtype: this.cfg.msgtype === 'm.text' ? 'm.text' : 'm.notice',
      body: String(body ?? ''),
      format: 'org.matrix.custom.html',
      formatted_body: String(formatted_body ?? ''),
      'm.mentions': {}, // 誰にもメンションしない
    };
    const txn = `worklog.${Date.now()}.${randomBytes(8).toString('hex')}`;
    const url = `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${encodeURIComponent(txn)}`;
    for (let attempt = 0; ; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      let res;
      try {
        res = await this.fetch(url, {
          method: 'PUT',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' },
          body: JSON.stringify(content),
          redirect: 'error',
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const j = await res.json().catch(() => null);
      if (res.ok && typeof j?.event_id === 'string') {
        const via = room.includes(':') ? `?via=${encodeURIComponent(room.slice(room.indexOf(':') + 1))}` : '';
        return { url: `https://matrix.to/#/${encodeURIComponent(room)}/${encodeURIComponent(j.event_id)}${via}`, eventId: j.event_id };
      }
      if (res.status === 429) {
        const header = Number(res.headers.get('retry-after')) * 1000;
        const wait = Number(j?.retry_after_ms) || (Number.isFinite(header) && header > 0 ? header : 1000);
        if (attempt < RETRIES && wait <= MAX_WAIT_MS) {
          await this.sleep(wait);
          continue; // 同じ txnId で送り直す
        }
        throw new Error(`Matrix の送信が制限されています(${Math.ceil(wait / 1000)}秒後に再試行してください)`);
      }
      const code = j?.errcode ? `${j.errcode} ` : '';
      const hint =
        res.status === 401 ? '(アクセストークンが違うか、失効しています)' : res.status === 403 ? '(このユーザーがルームに参加していないか、投稿の権限がありません)' : res.status === 404 ? '(ホームサーバーの URL かルーム ID が違います)' : '';
      throw new Error(`Matrix ${res.status}${hint}: ${code}${String(j?.error || '').slice(0, 200)}`.trim());
    }
  }
}
