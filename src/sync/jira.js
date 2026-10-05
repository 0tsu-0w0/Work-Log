// Jira の作業ログ(worklog)への記録。Jira の課題に紐付いたセッションだけを、その課題に記録する。
// 本物の Jira では試していない(Jira Cloud にこの環境から届かず、Jira Software の Docker イメージはライセンスが要るため)。
// 偽のサーバーでのテストのみ。API の形は Atlassian の REST API の文書に合わせている:
//   Cloud(v3): POST /rest/api/3/issue/{key}/worklog {started: "2021-01-17T12:34:00.000+0000", timeSpentSeconds, comment(ADF の doc)}、
//     PUT / DELETE /rest/api/3/issue/{key}/worklog/{id}。応答の id は文字列。
//   Server / Data Center(v2): 同じパスの /rest/api/2/…。comment は文字列。
// 認証は課題の取得と同じ(Cloud: JIRA_EMAIL + JIRA_API_TOKEN の Basic / Server・DC: JIRA_PAT の Bearer)。
// 接続先: config.json の tasks.jira.baseUrl か環境変数 JIRA_BASE_URL。API の版は jira.apiVersion(2 / 3)で変えられる
//   (省くと Basic 認証なら 3、PAT なら 2)。
// 記録の ID は "<課題キー>:<作業ログの ID>"(更新・削除に課題キーが要るため)。紐付く課題が変わったら、古い課題の記録を消して作り直す。
// 残り見積もりは Jira の既定(adjustEstimate=auto)のとおりに減る。
import { SyncClient } from './base.js';
import { baseUrlOf } from '../trackers/redmine.js';

// "2026-10-04T01:02:03.000+0000"(Jira の started の形。UTC で送る)
export const jiraTime = (v) => new Date(v).toISOString().replace('Z', '+0000');

export class JiraWorklog extends SyncClient {
  constructor(opts = {}) {
    super({ name: 'jira', label: 'Jira(作業ログ)', defaultBase: '', minIntervalMs: 200, ...opts });
  }

  url() {
    return baseUrlOf(this.env.WORKLOG_JIRA_API || this.all?.tasks?.jira?.baseUrl || this.env.JIRA_BASE_URL);
  }

  auth() {
    const { JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PAT } = this.env;
    if (JIRA_EMAIL && JIRA_API_TOKEN) return `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`;
    if (JIRA_PAT) return `Bearer ${JIRA_PAT}`;
    return null;
  }

  apiVersion() {
    const v = Number(this.cfg.apiVersion);
    if (v === 2 || v === 3) return v;
    return this.env.JIRA_EMAIL && this.env.JIRA_API_TOKEN ? 3 : 2;
  }

  configured() {
    return Boolean(this.url() && this.auth());
  }

  missing() {
    const m = [];
    if (!this.url()) m.push('JIRA_BASE_URL(または config.json の tasks.jira.baseUrl)');
    if (!this.auth()) m.push('JIRA_EMAIL + JIRA_API_TOKEN(または JIRA_PAT)');
    return m;
  }

  destination() {
    return `${this.url()}(Jira の課題に紐付いたセッションのみ)`;
  }

  headers() {
    return { authorization: this.auth() };
  }

  path(key, id = '') {
    return `${this.url()}/rest/api/${this.apiVersion()}/issue/${encodeURIComponent(key)}/worklog${id ? `/${encodeURIComponent(id)}` : ''}`;
  }

  // 紐付いた Jira の課題(複数あれば最初のもの)。無ければ null(記録しない)
  payload(e) {
    const key = (e.links || []).find((l) => l.provider === 'jira')?.id;
    if (!key) return null;
    const text = String(e.title);
    return {
      key,
      body: {
        started: jiraTime(e.start),
        timeSpentSeconds: Math.max(60, Math.round(e.ms / 60000) * 60), // Jira は分単位(1分未満は受け付けない)
        comment: this.apiVersion() === 3 ? { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } : text,
      },
    };
  }

  async create(e) {
    const p = this.payload(e);
    const j = await this.request('POST', this.path(p.key), { headers: this.headers(), body: p.body });
    if (!j?.id) throw new Error('Jira の応答に作業ログの ID がありません');
    return `${p.key}:${j.id}`;
  }

  async update(id, e) {
    const [key, wid] = splitId(id);
    const p = this.payload(e);
    if (p.key !== key) {
      // 作業ログは課題をまたいで動かせないので、作り直す
      await this.remove(id).catch((err) => {
        if (err.status !== 404) throw err;
      });
      return this.create(e);
    }
    await this.request('PUT', this.path(key, wid), { headers: this.headers(), body: p.body });
    return id;
  }

  async remove(id) {
    const [key, wid] = splitId(id);
    await this.request('DELETE', this.path(key, wid), { headers: this.headers() });
  }
}

function splitId(id) {
  const i = String(id).lastIndexOf(':');
  return [String(id).slice(0, i), String(id).slice(i + 1)];
}
