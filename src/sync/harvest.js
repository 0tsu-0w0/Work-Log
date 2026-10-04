// Harvest への記録(API v2)。
// 公式の文書(help.getharvest.com/api-v2)と API はこの環境から読めなかったため、次の SDK の実装で確かめた:
//   npm "harvest-v2" 3.0.0(https://api.harvestapp.com/v2/time_entries、ヘッダー Authorization: Bearer / Harvest-Account-ID / User-Agent、
//     更新は PATCH、削除は DELETE)、npm "node-harvest-api" 1.0.6(同じヘッダー、time_entries の PATCH)。
//   公式の古い文書(harvesthq/api の README)で User-Agent を付けるよう求めていることも確かめた。
// 確認していないもの(実際のアカウントでは試していない): 本文の project_id / task_id / spent_date / hours / notes の扱い
//   (SDK は本文をそのまま渡すだけなので、項目名は SDK からは確かめられていない)、
//   開始・終了の時刻で記録する設定のアカウントで hours が受け付けられるか、エラー応答の形。
// 認証: HARVEST_ACCESS_TOKEN と HARVEST_ACCOUNT_ID(Personal Access Token)。
// 記録先: config.json の harvest.projectId と harvest.taskId(必須)。harvest.projects に
//   { "Work Log のプロジェクト名": { "projectId": 1, "taskId": 2 } } を書くとプロジェクトごとに変えられる。
// 時間は作業時間(区間の長さ)を時間単位で、0.01 時間に丸めて送る。日付は harvest.timeZone(無ければこのマシンのタイムゾーン)の日付。
import { SyncClient } from './base.js';

const USER_AGENT = 'Work Log (local)';

export class Harvest extends SyncClient {
  constructor(opts = {}) {
    super({ name: 'harvest', label: 'Harvest', defaultBase: 'https://api.harvestapp.com/v2', minIntervalMs: 150, ...opts });
  }

  pair(v) {
    const projectId = Number(v?.projectId);
    const taskId = Number(v?.taskId);
    return projectId > 0 && taskId > 0 ? { projectId, taskId } : null;
  }

  targetOf(project) {
    const map = this.cfg.projects && typeof this.cfg.projects === 'object' ? this.cfg.projects : {};
    return (Object.hasOwn(map, project) && this.pair(map[project])) || this.pair(this.cfg);
  }

  hasTarget() {
    const map = this.cfg.projects && typeof this.cfg.projects === 'object' ? this.cfg.projects : {};
    return Boolean(this.pair(this.cfg) || Object.values(map).some((v) => this.pair(v)));
  }

  configured() {
    return Boolean(this.env.HARVEST_ACCESS_TOKEN && this.env.HARVEST_ACCOUNT_ID && this.hasTarget());
  }

  missing() {
    const m = ['HARVEST_ACCESS_TOKEN', 'HARVEST_ACCOUNT_ID'].filter((k) => !this.env[k]);
    if (!this.hasTarget()) m.push('config.json の harvest.projectId と harvest.taskId');
    return m;
  }

  destination() {
    const p = this.pair(this.cfg);
    return p ? `プロジェクト ${p.projectId}` : 'プロジェクトごとの設定';
  }

  headers() {
    return { authorization: `Bearer ${this.env.HARVEST_ACCESS_TOKEN}`, 'harvest-account-id': String(this.env.HARVEST_ACCOUNT_ID), 'user-agent': USER_AGENT };
  }

  // 記録先のプロジェクトが決まらないもの(割り当ての無いプロジェクト)は null(記録しない)
  payload(e) {
    const t = this.targetOf(e.project);
    if (!t) return null;
    return {
      project_id: t.projectId,
      task_id: t.taskId,
      spent_date: e.localDate,
      hours: Math.max(0.01, Math.round((e.ms / 3600000) * 100) / 100),
      notes: e.title,
    };
  }

  async create(e) {
    const j = await this.request('POST', `${this.base}/time_entries`, { headers: this.headers(), body: this.payload(e) });
    if (!j?.id) throw new Error('Harvest の応答に記録の ID がありません');
    return String(j.id);
  }

  async update(id, e) {
    await this.request('PATCH', `${this.base}/time_entries/${encodeURIComponent(id)}`, { headers: this.headers(), body: this.payload(e) });
  }

  async remove(id) {
    await this.request('DELETE', `${this.base}/time_entries/${encodeURIComponent(id)}`, { headers: this.headers() });
  }
}
