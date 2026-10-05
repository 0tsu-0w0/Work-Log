// Prometheus のテキスト形式(text/plain; version=0.0.4)の指標。GET /metrics で返す(WORKLOG_METRICS=1 か config.json の metrics.enabled のときだけ)。
// 値は手元に残っているログ全体の累計。Claude Code は古いログを自動で消す(既定で30日)ので、消えた分だけ counter が減ることがある
// (Prometheus は減少をリセットとして扱うので、rate() / increase() はそのまま使える)。
// ラベルの値は秘匿情報を伏せてから、\ " 改行をエスケープして書く。# HELP の文は \ と改行をエスケープする。
// サーバーは 127.0.0.1 だけで待ち受け、Host が 127.0.0.1 / localhost のときだけ応じる。Docker の中の Prometheus から取るときは
//   --network host で動かし、targets に 127.0.0.1:<ポート> を書く(ブリッジのネットワークからは届かない)。
// 実際に確かめたもの(2026-10-05): Prometheus 3.15.0(Docker の prom/prometheus:latest、--network host)で 5秒ごとに取らせ、
//   targets の health が up になること、HTTP API の /api/v1/query で work_log_active_seconds_total(プロジェクトごと)・
//   sum(work_log_sessions_total)・sum(work_log_commits_total)・sum(work_log_api_equivalent_usd_total)・work_log_in_progress_sessions が
//   Work Log の /api/sessions と /metrics の値と一致すること、" と \ を含むプロジェクト名のラベルが元の文字列に戻ること。
//   同じ image の promtool 3.15.0 の `promtool check metrics` で警告・誤りが無いこと(壊した入力では誤りになることも確かめた)。
// 確かめていないもの: Prometheus 以外(VictoriaMetrics・Grafana Agent など)からの取得、OpenMetrics 形式での応答。
import { mask } from './mask.js';

export const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export const escapeLabel = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
export const escapeHelp = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

const TOKEN_TYPES = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'];

// 値の書き方(整数はそのまま、小数は丸め誤差を残さない程度に)
const num = (v) => (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(15))));

function family(name, type, help, samples) {
  const lines = [`# HELP ${name} ${escapeHelp(help)}`, `# TYPE ${name} ${type}`];
  const sorted = [...samples].sort((a, b) => a.key.localeCompare(b.key));
  for (const s of sorted) {
    const labels = Object.entries(s.labels);
    lines.push(`${name}${labels.length ? `{${labels.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}` : ''} ${num(s.value)}`);
  }
  return lines;
}

// 同じラベルの組の値を足し合わせる
function sum() {
  const m = new Map();
  return {
    add(labels, v) {
      const key = JSON.stringify(labels);
      const cur = m.get(key) || { key, labels, value: 0 };
      cur.value += v;
      m.set(key, cur);
    },
    list: () => m.values(),
  };
}

// sessions: store.sessions() の形 / costs: store.costs() の結果(1時間・モデル・プロジェクトごとの集計)
export function buildMetrics({ sessions, costs }) {
  const active = sum();
  const count = sum();
  const commits = sum();
  let inProgress = 0;
  for (const s of sessions) {
    const labels = { project: mask(s.project || ''), tool: s.tool || 'claude' };
    active.add(labels, (s.activeMs || 0) / 1000);
    count.add(labels, 1);
    commits.add(labels, s.commits || 0);
    if (s.status && s.status !== 'done') inProgress++;
  }
  const usd = sum();
  const tokens = sum();
  for (const b of costs?.buckets || []) {
    if (b.priced) usd.add({ project: mask(b.project || ''), tool: b.tool || 'claude', model: mask(b.model || '') }, b.usd);
    TOKEN_TYPES.forEach((type, i) => tokens.add({ model: mask(b.model || ''), type }, b.tokens[i] || 0));
  }
  const lines = [
    ...family('work_log_active_seconds_total', 'counter', '作業時間の合計(秒)。30分以上の空きを除いた区間の長さ', active.list()),
    ...family('work_log_sessions_total', 'counter', 'セッションの数', count.list()),
    ...family('work_log_commits_total', 'counter', 'セッション中のコミットの数', commits.list()),
    ...family('work_log_api_equivalent_usd_total', 'counter', 'API 換算のコスト(USD)。単価のわからないモデルは含まない', usd.list()),
    ...family('work_log_tokens_total', 'counter', 'トークン数(type: input / output / cache_read / cache_write_5m / cache_write_1h)', tokens.list()),
    ...family('work_log_in_progress_sessions', 'gauge', '作業中・入力待ちのセッションの数', [{ key: '', labels: {}, value: inProgress }]),
  ];
  return `${lines.join('\n')}\n`;
}

