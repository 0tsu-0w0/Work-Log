// Toggl Track への記録(API v9)。
// 公式の文書(engineering.toggl.com / developers.track.toggl.com)はこの環境から読めなかったため、次の2つの SDK の実装で確かめた:
//   npm "toggl-track" 0.9.1(2026-07 公開。v9 用。https://api.track.toggl.com/api/v9、Basic 認証 "<token>:api_token"、
//     POST/PUT/DELETE workspaces/{wid}/time_entries[/{id}]、本文の created_with / description / start / stop / duration /
//     tags / project_id / workspace_id、GET me の default_workspace_id)
//   npm "toggl-client" 3.7.2(2026-10 公開。同じパスと created_with)
// 確認していないもの(実際のアカウントでは試していない): tags に無い名前を渡したときにタグが作られるか、エラー応答の形、
//   利用制限の値(1秒に1回程度を目安に間隔を空けて送る)。
// 認証: TOGGL_API_TOKEN。ワークスペース: config.json の toggl.workspaceId(無ければ既定のワークスペース)。
// プロジェクト: config.json の toggl.projects に { "Work Log のプロジェクト名": Toggl のプロジェクト ID } を書くと割り当てる。
import { SyncClient, isoSeconds } from './base.js';

export class Toggl extends SyncClient {
  constructor(opts = {}) {
    super({ name: 'toggl', label: 'Toggl Track', defaultBase: 'https://api.track.toggl.com/api/v9', minIntervalMs: 1000, ...opts });
    this.defaultWorkspace = null;
  }

  configured() {
    return Boolean(this.env.TOGGL_API_TOKEN);
  }

  missing() {
    return ['TOGGL_API_TOKEN'];
  }

  destination() {
    return this.cfg.workspaceId ? `ワークスペース ${this.cfg.workspaceId}` : '既定のワークスペース';
  }

  headers() {
    return { authorization: `Basic ${Buffer.from(`${this.env.TOGGL_API_TOKEN}:api_token`).toString('base64')}` };
  }

  async workspaceId() {
    if (this.cfg.workspaceId) return Number(this.cfg.workspaceId);
    if (!this.defaultWorkspace) {
      const me = await this.request('GET', `${this.base}/me`, { headers: this.headers() });
      if (!me?.default_workspace_id) throw new Error('Toggl Track の既定のワークスペースがわかりません(config.json の toggl.workspaceId を設定してください)');
      this.defaultWorkspace = Number(me.default_workspace_id);
    }
    return this.defaultWorkspace;
  }

  projectId(project) {
    const map = this.cfg.projects && typeof this.cfg.projects === 'object' ? this.cfg.projects : {};
    const v = Object.hasOwn(map, project) ? Number(map[project]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  // workspace_id は送るときに足す(既定のワークスペースは問い合わせないとわからないため)
  payload(e) {
    const pid = this.projectId(e.project);
    return {
      created_with: 'work-log',
      description: e.title,
      start: isoSeconds(e.start),
      stop: isoSeconds(e.end),
      duration: Math.max(0, Math.round((Date.parse(e.end) - Date.parse(e.start)) / 1000)),
      tags: ['work-log', ...(e.project ? [e.project] : [])],
      ...(pid ? { project_id: pid } : {}),
    };
  }

  async create(e) {
    const wid = await this.workspaceId();
    const j = await this.request('POST', `${this.base}/workspaces/${wid}/time_entries`, { headers: this.headers(), body: { ...this.payload(e), workspace_id: wid } });
    if (!j?.id) throw new Error('Toggl Track の応答に記録の ID がありません');
    return String(j.id);
  }

  async update(id, e) {
    const wid = await this.workspaceId();
    await this.request('PUT', `${this.base}/workspaces/${wid}/time_entries/${encodeURIComponent(id)}`, { headers: this.headers(), body: { ...this.payload(e), workspace_id: wid } });
  }

  async remove(id) {
    const wid = await this.workspaceId();
    await this.request('DELETE', `${this.base}/workspaces/${wid}/time_entries/${encodeURIComponent(id)}`, { headers: this.headers() });
  }
}
