// Redmine の作業時間(time entries)への記録。
// 本物のサーバーで確かめたもの(Docker の redmine:6 = Redmine 6.1.5.stable、SQLite、既定データを読み込んだ状態、2026-10):
//   POST /time_entries.json {time_entry:{issue_id | project_id, spent_on, hours, comments, activity_id}} が 201 と {time_entry:{id}} を返すこと、
//   PUT /time_entries/{id}.json が 204、DELETE が 204、消えた ID の更新が 404 になること(Work Log は作り直す)、
//   `work-log sync --redmine-time` の2回目は何も作らず、タイトルを変えると更新、区間が消えると削除されること、
//   途中で 422 で止まっても、次の実行で続きから記録されること、spent_on が redmine.timeZone(Asia/Tokyo)の日付になること、
//   project_id に識別子("wlb")を渡すと 422 {"errors":["Project is invalid"]} になること(数値の ID だけを受け付ける。
//   識別子は GET /projects/{識別子}.json で ID に直してから送る)、X-Redmine-API-Key ヘッダーでの認証、
//   既定データには「既定」の作業分類が無く、activity_id を省くと 422 {"errors":["Activity cannot be blank"]} になること
//   (GET /enumerations/time_entry_activities.json の is_default で既定を探し、無ければ設定を求める)。
// 確かめていないもの: Redmine 5.x 以前、プロジェクトごとに作業分類を変えている場合、コメントの長さの上限(255文字に切り詰めて送る)。
// 認証: 環境変数 REDMINE_URL(または config.json の tasks.redmine.baseUrl)と REDMINE_API_KEY。記録はこの鍵の利用者のものになる。
// 記録先: セッションに Redmine の課題が紐付いていればその課題、無ければ config.json の redmine.projects
//   { "Work Log のプロジェクト名": Redmine のプロジェクトの ID か識別子 } か redmine.projectId。どれも無ければ記録しない。
// 作業分類: config.json の redmine.activityId(無ければ Redmine の既定の作業分類)。
// 時間は作業時間(区間の長さ)を時間単位で、0.01 時間に丸めて送る。日付は redmine.timeZone(無ければこのマシンのタイムゾーン)の日付。
import { SyncClient } from './base.js';
import { baseUrlOf } from '../trackers/redmine.js';

const MAX_COMMENTS = 255;

export class RedmineTime extends SyncClient {
  constructor(opts = {}) {
    super({ name: 'redmine', label: 'Redmine(作業時間)', defaultBase: '', minIntervalMs: 100, ...opts });
    this.activity = null; // 既定の作業分類(問い合わせた結果)
    this.projectIds = new Map(); // プロジェクトの識別子 -> 数値の ID
  }

  url() {
    return baseUrlOf(this.env.WORKLOG_REDMINE_API || this.all?.tasks?.redmine?.baseUrl || this.env.REDMINE_URL);
  }

  configured() {
    return Boolean(this.url() && this.env.REDMINE_API_KEY);
  }

  missing() {
    const m = [];
    if (!this.url()) m.push('REDMINE_URL');
    if (!this.env.REDMINE_API_KEY) m.push('REDMINE_API_KEY');
    return m;
  }

  destination() {
    const p = this.cfg.projectId;
    return `${this.url()}(課題に紐付いたもの${p ? `・それ以外はプロジェクト ${p}` : ''})`;
  }

  headers() {
    return { 'x-redmine-api-key': this.env.REDMINE_API_KEY };
  }

  projectOf(project) {
    const map = this.cfg.projects && typeof this.cfg.projects === 'object' ? this.cfg.projects : {};
    const v = Object.hasOwn(map, project) ? map[project] : this.cfg.projectId;
    return typeof v === 'number' || (typeof v === 'string' && /^[\w-]{1,100}$/.test(v)) ? v : null;
  }

  // 課題の番号(紐付いた Redmine の課題。複数あれば最初のもの)か、プロジェクト。どちらも無ければ null(記録しない)
  payload(e) {
    const issue = (e.links || []).find((l) => l.provider === 'redmine' && Number.isInteger(l.number))?.number;
    const project = issue ? null : this.projectOf(e.project);
    if (!issue && project === null) return null;
    const activity = Number(this.cfg.activityId);
    return {
      time_entry: {
        ...(issue ? { issue_id: issue } : { project_id: project }),
        spent_on: e.localDate,
        hours: Math.max(0.01, Math.round((e.ms / 3600000) * 100) / 100),
        comments: [...String(e.title)].slice(0, MAX_COMMENTS).join(''),
        ...(activity > 0 ? { activity_id: activity } : {}),
      },
    };
  }

  // プロジェクトの識別子は数値の ID に直す(time_entries の project_id は識別子を受け付けない)
  async projectId(v) {
    if (typeof v === 'number' || /^\d+$/.test(v)) return Number(v);
    if (!this.projectIds.has(v)) {
      const j = await this.request('GET', `${this.url()}/projects/${encodeURIComponent(v)}.json`, { headers: this.headers() });
      if (!j?.project?.id) throw new Error(`Redmine のプロジェクトが見つかりません: ${v}`);
      this.projectIds.set(v, j.project.id);
    }
    return this.projectIds.get(v);
  }

  // 作業分類の指定が無いときは、Redmine の既定の作業分類を使う(無ければ設定を求める)
  async body(e) {
    const b = this.payload(e);
    if (b.time_entry.project_id !== undefined) b.time_entry.project_id = await this.projectId(b.time_entry.project_id);
    if (b.time_entry.activity_id) return b;
    if (!this.activity) {
      const j = await this.request('GET', `${this.url()}/enumerations/time_entry_activities.json`, { headers: this.headers() });
      const list = (j?.time_entry_activities || []).filter((a) => a.active !== false);
      const def = list.find((a) => a.is_default);
      if (!def) {
        const names = list.map((a) => `${a.id}: ${a.name}`).join('、') || 'なし';
        throw new Error(`Redmine に既定の作業分類がありません。config.json の redmine.activityId に作業分類の ID を設定してください(${names})`);
      }
      this.activity = def.id;
    }
    return { time_entry: { ...b.time_entry, activity_id: this.activity } };
  }

  async create(e) {
    const j = await this.request('POST', `${this.url()}/time_entries.json`, { headers: this.headers(), body: await this.body(e) });
    if (!j?.time_entry?.id) throw new Error('Redmine の応答に作業時間の ID がありません');
    return String(j.time_entry.id);
  }

  async update(id, e) {
    await this.request('PUT', `${this.url()}/time_entries/${encodeURIComponent(id)}.json`, { headers: this.headers(), body: await this.body(e) });
  }

  async remove(id) {
    await this.request('DELETE', `${this.url()}/time_entries/${encodeURIComponent(id)}.json`, { headers: this.headers() });
  }
}
