// Clockify への記録(API v1)。
// 公式の文書(docs.clockify.me)と API はこの環境から読めなかったため、次の2つの SDK の実装と型で確かめた:
//   npm "clockify-sdk" 0.1.1(https://api.clockify.me/api/v1、ヘッダー X-Api-Key、
//     POST /workspaces/{ws}/time-entries・PUT/DELETE /workspaces/{ws}/time-entries/{id}、
//     本文の start / end / description(3000文字まで)/ projectId / tagIds / billable、GET /user の activeWorkspace / defaultWorkspace)
//   npm "clockify-ts" 1.2108.13(同じ API の場所と X-Api-Key、新しい記録の形)
// 確認していないもの(実際のアカウントでは試していない): PUT で省いた項目が消えるか(省かずに全部送っている)、エラー応答の形、
//   地域ごとの API の場所(EU などのデータ保存地域を選んだワークスペース。config.json の clockify.baseUrl で変えられる)。
// 認証: CLOCKIFY_API_KEY。ワークスペース: config.json の clockify.workspaceId(無ければ GET /user の activeWorkspace)。
// プロジェクト: clockify.projects に { "Work Log のプロジェクト名": "Clockify のプロジェクト ID" }、タグ: clockify.tagIds(ID の配列)。
import { SyncClient, isoSeconds } from './base.js';

const DESCRIPTION_MAX = 3000;

export class Clockify extends SyncClient {
  constructor(opts = {}) {
    super({ name: 'clockify', label: 'Clockify', defaultBase: 'https://api.clockify.me/api/v1', minIntervalMs: 100, ...opts });
    this.activeWorkspace = null;
  }

  setConfig(cfg = {}) {
    super.setConfig(cfg);
    // 地域ごとの API(https://<地域>.clockify.me/api/v1 など)。clockify.me の https だけを受け付ける
    this.envBase ??= this.base; // 最初の呼び出し(親のコンストラクターの中)で既定の場所を覚える
    this.base = this.envBase;
    if (!this.env.WORKLOG_CLOCKIFY_API && this.cfg.baseUrl) {
      try {
        const u = new URL(String(this.cfg.baseUrl));
        if (u.protocol === 'https:' && (u.hostname === 'clockify.me' || u.hostname.endsWith('.clockify.me'))) this.base = u.href.replace(/\/+$/, '');
      } catch {
        // 読めなければ既定の場所を使う
      }
    }
  }

  configured() {
    return Boolean(this.env.CLOCKIFY_API_KEY);
  }

  missing() {
    return ['CLOCKIFY_API_KEY'];
  }

  destination() {
    return this.cfg.workspaceId ? `ワークスペース ${this.cfg.workspaceId}` : '使用中のワークスペース';
  }

  headers() {
    return { 'x-api-key': this.env.CLOCKIFY_API_KEY };
  }

  async workspaceId() {
    if (this.cfg.workspaceId) return String(this.cfg.workspaceId);
    if (!this.activeWorkspace) {
      const me = await this.request('GET', `${this.base}/user`, { headers: this.headers() });
      const ws = me?.activeWorkspace || me?.defaultWorkspace;
      if (!ws) throw new Error('Clockify のワークスペースがわかりません(config.json の clockify.workspaceId を設定してください)');
      this.activeWorkspace = String(ws);
    }
    return this.activeWorkspace;
  }

  payload(e) {
    const map = this.cfg.projects && typeof this.cfg.projects === 'object' ? this.cfg.projects : {};
    const projectId = Object.hasOwn(map, e.project) && map[e.project] ? String(map[e.project]) : null;
    const tagIds = Array.isArray(this.cfg.tagIds) ? this.cfg.tagIds.map(String).filter(Boolean) : [];
    return {
      start: isoSeconds(e.start),
      end: isoSeconds(Math.max(Date.parse(e.end), Date.parse(e.start) + 1000)),
      description: e.title.slice(0, DESCRIPTION_MAX),
      ...(projectId ? { projectId } : {}),
      ...(tagIds.length ? { tagIds } : {}),
      ...(this.cfg.billable !== undefined ? { billable: Boolean(this.cfg.billable) } : {}),
    };
  }

  async entriesUrl(id) {
    const ws = await this.workspaceId();
    return `${this.base}/workspaces/${encodeURIComponent(ws)}/time-entries${id ? `/${encodeURIComponent(id)}` : ''}`;
  }

  async create(e) {
    const j = await this.request('POST', await this.entriesUrl(), { headers: this.headers(), body: this.payload(e) });
    if (!j?.id) throw new Error('Clockify の応答に記録の ID がありません');
    return String(j.id);
  }

  async update(id, e) {
    await this.request('PUT', await this.entriesUrl(id), { headers: this.headers(), body: this.payload(e) });
  }

  async remove(id) {
    await this.request('DELETE', await this.entriesUrl(id), { headers: this.headers() });
  }
}
