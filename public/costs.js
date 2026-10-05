// コストビュー: KPI、日別の積み上げ棒グラフ(モデル系統別)、内訳の表。
// 色はモデル系統に固定で割り当てる(順位で塗り替えない)。系統の並びは配色検証済みの順。
const FAMILIES = ['Opus', 'Sonnet', 'Haiku', 'Fable', 'OpenAI', 'その他'];
const FAMILY_VAR = { Opus: '--series-1', Sonnet: '--series-2', Haiku: '--series-3', Fable: '--series-4', OpenAI: '--series-5', その他: '--series-other' };
const TOKEN_LABELS = ['入力', '出力', 'キャッシュ読込', 'キャッシュ書込(5分)', 'キャッシュ書込(1時間)'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (v) => (v === 0 ? '$0' : v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`);
const num = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sum = (a) => a.reduce((x, y) => x + y, 0);

// UTC の時間バケットを、ブラウザのタイムゾーンの日付に振り分ける
function byDay(buckets, days) {
  const map = new Map(days.map((d) => [dayKey(d), Object.fromEntries(FAMILIES.map((f) => [f, 0]))]));
  for (const b of buckets) {
    const k = dayKey(new Date(`${b.hour}:00:00Z`));
    if (map.has(k)) map.get(k)[FAMILIES.includes(b.family) ? b.family : 'その他'] += b.usd;
  }
  return days.map((d) => ({ date: d, values: map.get(dayKey(d)) }));
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

// 上端だけ角丸(4px)の棒。基線側は四角いまま
function topRounded(x, y, w, h, r) {
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function chartSvg(rows, width, present) {
  const H = 220;
  const pad = { l: 52, r: 8, t: 8, b: 26 };
  const plotW = width - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const totals = rows.map((r) => sum(Object.values(r.values)));
  const max = niceMax(Math.max(...totals));
  const y = (v) => pad.t + plotH - (v / max) * plotH;
  const band = plotW / rows.length;
  const barW = Math.max(4, Math.min(40, band * 0.62));
  const labelEvery = rows.length > 14 ? Math.ceil(rows.length / 10) : 1;

  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y(v)}" y2="${y(v)}" class="grid${i === 0 ? ' base' : ''}"/>
      <text x="${pad.l - 6}" y="${y(v) + 4}" class="tick" text-anchor="end">${usd(v)}</text>`;
  }
  let bars = '';
  rows.forEach((r, i) => {
    const cx = pad.l + band * i + band / 2;
    const x = cx - barW / 2;
    const segs = present.filter((f) => r.values[f] > 0);
    let acc = 0;
    segs.forEach((f, j) => {
      const v = r.values[f];
      const top = y(acc + v);
      const bottom = y(acc);
      // 積み上げの間に 2px の面色の隙間を空ける(枠線は描かない)
      const h = Math.max(1, bottom - top - (j > 0 ? 2 : 0));
      const fill = `var(${FAMILY_VAR[f]})`;
      bars += j === segs.length - 1
        ? `<path d="${topRounded(x, top, barW, h, 4)}" fill="${fill}"/>`
        : `<rect x="${x}" y="${top}" width="${barW}" height="${h}" fill="${fill}"/>`;
      acc += v;
    });
    if (i % labelEvery === 0) {
      const d = r.date;
      bars += `<text x="${cx}" y="${H - 8}" class="tick" text-anchor="middle">${d.getMonth() + 1}/${d.getDate()}</text>`;
    }
    // 当たり判定は棒より広く、列全体にとる
    bars += `<rect x="${pad.l + band * i}" y="${pad.t}" width="${band}" height="${plotH}" class="hit" data-i="${i}"/>`;
  });
  return `<svg width="${width}" height="${H}" role="img" aria-label="日別の API換算(参考値・請求額ではありません)">${grid}${bars}</svg>`;
}

function tooltipHtml(row, present) {
  const total = sum(Object.values(row.values));
  const d = row.date;
  const lines = present
    .filter((f) => row.values[f] > 0)
    .map((f) => `<div class="tt-row"><span class="sw" style="background:var(${FAMILY_VAR[f]})"></span><span>${esc(f)}</span><b>${usd(row.values[f])}</b></div>`);
  return `<div class="tt-title">${d.getMonth() + 1}月${d.getDate()}日(${'日月火水木金土'[d.getDay()]})</div>
    ${lines.join('') || '<div class="tt-row">利用なし</div>'}
    <div class="tt-row tt-total"><span></span><span>合計</span><b>${usd(total)}</b></div>`;
}

function groupTable(buckets, keyOf, label) {
  const g = new Map();
  for (const b of buckets) {
    const k = keyOf(b);
    const row = g.get(k) || { key: k, family: b.family, usd: 0, tokens: [0, 0, 0, 0, 0, 0], priced: true };
    b.tokens.forEach((v, i) => (row.tokens[i] += v));
    row.usd += b.usd;
    row.priced &&= b.priced;
    g.set(k, row);
  }
  const rows = [...g.values()].sort((a, b) => b.usd - a.usd);
  const total = sum(rows.map((r) => r.usd)) || 1;
  return `<table class="cost-table">
    <thead><tr><th>${label}</th><th class="n" title="参考値・請求額ではありません">API換算</th><th class="n">割合</th><th class="n">入力</th><th class="n">出力</th><th class="n">キャッシュ読込</th><th class="n">キャッシュ書込</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${label === 'モデル' ? `<span class="sw" style="background:var(${FAMILY_VAR[r.family] || '--series-other'})"></span>` : ''}${esc(r.key)}</td>
      <td class="n">${r.priced ? usd(r.usd) : '<span class="small" title="単価表にないモデルです">単価不明</span>'}</td>
      <td class="n">${((r.usd / total) * 100).toFixed(0)}%</td>
      <td class="n">${num(r.tokens[0])}</td><td class="n">${num(r.tokens[1])}</td>
      <td class="n">${num(r.tokens[2])}</td><td class="n">${num(r.tokens[3] + r.tokens[4])}</td>
    </tr>`).join('')}</tbody></table>`;
}

export function renderCosts(root, data, { days, onSession }) {
  const { buckets, topSessions, unknownModels, estimated, pricing } = data;
  const rows = byDay(buckets, days);
  const present = FAMILIES.filter((f) => rows.some((r) => r.values[f] > 0));
  const total = sum(buckets.map((b) => b.usd));
  const t = [0, 1, 2, 3, 4].map((i) => sum(buckets.map((b) => b.tokens[i])));
  const inputSide = t[0] + t[2] + t[3] + t[4];
  const hitRate = inputSide ? t[2] / inputSide : 0;
  const activeDays = rows.filter((r) => sum(Object.values(r.values)) > 0).length;

  root.innerHTML = `
    <div class="cost-head">
      <p class="small"><b>API換算（参考値・請求額ではありません）</b>: 同じ量を API の従量課金で使った場合の目安です。Pro/Max などの定額プランでは、この金額で請求されることはありません。単価は ${esc(pricing.asOf)} 時点の
        <a href="${esc(pricing.source)}" target="_blank" rel="noopener noreferrer">公式価格</a>。サブエージェントを含みます。
        ${estimated ? '一部の出力トークンはログに確定値がないため、本文の長さから見積もっています。' : ''}
        ${unknownModels.length ? `単価不明のモデル(${unknownModels.map(esc).join(', ')})は合計に含みません。<code>~/.work-log/pricing.json</code> に単価を書くと計算します(README の「コスト」を参照)。` : ''}</p>
    </div>
    <div class="kpis">
      <div class="kpi"><span>API換算の合計(参考値)</span><b>${usd(total)}</b></div>
      <div class="kpi"><span>作業日あたり</span><b>${usd(activeDays ? total / activeDays : 0)}</b><small>${activeDays}日</small></div>
      <div class="kpi"><span>トークン</span><b>${num(sum(t))}</b><small>出力 ${num(t[1])}</small></div>
      <div class="kpi"><span>キャッシュヒット率</span><b>${(hitRate * 100).toFixed(0)}%</b><small>入力側のうち読込</small></div>
    </div>
    <div class="chart-card">
      <div class="legend">${present.map((f) => `<span><span class="sw" style="background:var(${FAMILY_VAR[f]})"></span>${esc(f)}</span>`).join('')}</div>
      <div class="chart" id="cost-chart"></div>
      <div class="tooltip" id="cost-tt" hidden></div>
    </div>
    <div class="cost-tables">
      <h3>モデル別</h3>${buckets.length ? groupTable(buckets, (b) => b.model, 'モデル') : '<p class="hint">この期間の利用はありません。</p>'}
      ${buckets.length ? `<h3>プロジェクト別</h3>${groupTable(buckets, (b) => b.project, 'プロジェクト')}` : ''}
      ${topSessions.length ? `<h3>API換算の大きいセッション</h3><ol class="top-sessions">${topSessions.map((s) => `
        <li data-id="${esc(s.id)}"><span class="t">${esc(s.title)}</span><span class="small">${esc(s.project)} · ${new Date(s.start).toLocaleDateString('ja-JP')}</span><b>${usd(s.usd)}</b></li>`).join('')}</ol>` : ''}
    </div>`;

  const chart = root.querySelector('#cost-chart');
  const tt = root.querySelector('#cost-tt');
  const draw = () => {
    chart.innerHTML = chartSvg(rows, Math.max(280, chart.clientWidth), present);
    chart.querySelectorAll('.hit').forEach((h) => {
      h.addEventListener('mouseenter', () => {
        tt.innerHTML = tooltipHtml(rows[Number(h.dataset.i)], present);
        tt.hidden = false;
        chart.querySelectorAll('.hit').forEach((x) => x.classList.toggle('on', x === h));
      });
      h.addEventListener('mousemove', (e) => {
        const box = root.querySelector('.chart-card').getBoundingClientRect();
        const left = Math.min(e.clientX - box.left + 12, box.width - tt.offsetWidth - 4);
        tt.style.left = `${Math.max(4, left)}px`;
        tt.style.top = `${e.clientY - box.top + 12}px`;
      });
      h.addEventListener('mouseleave', () => {
        tt.hidden = true;
        h.classList.remove('on');
      });
    });
  };
  draw();
  root.querySelectorAll('.top-sessions li').forEach((li) => li.addEventListener('click', () => onSession(li.dataset.id)));
  return draw; // リサイズ時に呼ぶ
}
