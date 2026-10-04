// Google カレンダーへの記録。
// 確認したもの: Calendar API v3 の discovery 文書(https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest、revision 20260925)の
//   events.insert(POST calendars/{calendarId}/events)・events.update(PUT …/events/{eventId})・events.delete(DELETE …/events/{eventId})、
//   Event の summary / description / start.dateTime / end.dateTime(RFC 3339)/ colorId / extendedProperties.private の形、
//   OAuth のトークンの場所(https://accounts.google.com/.well-known/openid-configuration の token_endpoint = https://oauth2.googleapis.com/token)。
// 確認していないもの(実際の Google アカウントでは試していない): refresh_token での更新の応答(access_token / expires_in)、
//   削除済みの予定に対する 410 の扱い、エラー応答の文言。
// 認証: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN(calendar.events か calendar.app.created のスコープで取ったもの)。
// カレンダー: GOOGLE_CALENDAR_ID か config.json の gcal.calendarId(記録専用のカレンダーを作って、その ID を指定するのがおすすめ)。
import { SyncClient } from './base.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export class GoogleCalendar extends SyncClient {
  constructor(opts = {}) {
    super({ name: 'gcal', label: 'Google カレンダー', defaultBase: 'https://www.googleapis.com/calendar/v3', ...opts });
    this.tokenUrl = this.env.WORKLOG_GCAL_TOKEN_URL || TOKEN_URL;
    this.token = null; // { value, expiresAt }
  }

  calendarId() {
    return String(this.env.GOOGLE_CALENDAR_ID || this.cfg.calendarId || '').trim() || null;
  }

  credentials() {
    const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret, GOOGLE_REFRESH_TOKEN: refresh } = this.env;
    return id && secret && refresh ? { id, secret, refresh } : null;
  }

  configured() {
    return Boolean(this.credentials() && this.calendarId());
  }

  missing() {
    const m = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'].filter((k) => !this.env[k]);
    if (!this.calendarId()) m.push('GOOGLE_CALENDAR_ID(または config.json の gcal.calendarId)');
    return m;
  }

  destination() {
    const id = this.calendarId();
    return id === 'primary' ? 'メインのカレンダー' : `カレンダー ${id.length > 24 ? `${id.slice(0, 12)}…` : id}`;
  }

  // アクセストークンは期限の1分前まで使い回す
  async accessToken(now = Date.now()) {
    if (this.token && this.token.expiresAt > now) return this.token.value;
    const c = this.credentials();
    if (!c) throw new Error('Google カレンダーの認証情報がありません(GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN)');
    let j;
    try {
      j = await this.request('POST', this.tokenUrl, { form: { client_id: c.id, client_secret: c.secret, refresh_token: c.refresh, grant_type: 'refresh_token' } });
    } catch (err) {
      if (err.status === 400 || err.status === 401) throw Object.assign(new Error(`Google の認証に失敗しました(リフレッシュトークンが無効か期限切れです): ${err.message}`), { status: err.status });
      throw err;
    }
    if (!j?.access_token) throw new Error('Google の認証に失敗しました(アクセストークンが返りませんでした)');
    this.token = { value: j.access_token, expiresAt: now + (Number(j.expires_in) || 3600) * 1000 - 60000 };
    return this.token.value;
  }

  eventsUrl(id) {
    return `${this.base}/calendars/${encodeURIComponent(this.calendarId())}/events${id ? `/${encodeURIComponent(id)}` : ''}`;
  }

  payload(e) {
    const color = this.cfg.colorId !== undefined && this.cfg.colorId !== null && this.cfg.colorId !== '' ? String(this.cfg.colorId) : null;
    return {
      summary: e.title,
      description: e.description,
      start: { dateTime: e.start },
      end: { dateTime: new Date(Math.max(Date.parse(e.end), Date.parse(e.start) + 60000)).toISOString() },
      extendedProperties: { private: { workLogKey: e.key } },
      ...(color ? { colorId: color } : {}),
    };
  }

  async call(method, url, body) {
    const token = await this.accessToken();
    return this.request(method, url, { headers: { authorization: `Bearer ${token}` }, body });
  }

  async create(e) {
    const j = await this.call('POST', this.eventsUrl(), this.payload(e));
    if (!j?.id) throw new Error('Google カレンダーの応答に予定の ID がありません');
    return String(j.id);
  }

  async update(id, e) {
    await this.call('PUT', this.eventsUrl(id), this.payload(e));
  }

  async remove(id) {
    await this.call('DELETE', this.eventsUrl(id));
  }
}
