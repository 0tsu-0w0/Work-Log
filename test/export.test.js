import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, zip, xmlText, colName, buildXlsx, excelSerial } from '../src/xlsx.js';
import { csvField, neutralize, toCsv, exportRows, COLUMNS } from '../src/export.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

// ZIP を読む(中央ディレクトリから。CRC も確かめる)
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'EOCD がない');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    assert.equal(flags & 0x0800, 0x0800);
    assert.equal(buf.readUInt32LE(off), 0x04034b50);
    const lnlen = buf.readUInt16LE(off + 26);
    const lxlen = buf.readUInt16LE(off + 28);
    const comp = buf.subarray(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
    const data = method === 8 ? inflateRawSync(comp) : comp;
    assert.equal(crc32(data), crc, `${name} の CRC`);
    files[name] = data.toString('utf8');
    p += 46 + nlen + xlen + clen;
  }
  return files;
}

test('CRC-32 と ZIP', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
  const z = zip([{ name: 'a.txt', data: 'あいう'.repeat(100) }, { name: 'dir/日本語.xml', data: Buffer.from('<x/>') }], { now: Date.UTC(2026, 9, 5, 12, 34, 56) });
  const files = unzip(z);
  assert.deepEqual(Object.keys(files), ['a.txt', 'dir/日本語.xml']);
  assert.equal(files['a.txt'], 'あいう'.repeat(100));
  assert.equal(z.readUInt16LE(12), ((2026 - 1980) << 9) | (10 << 5) | 5); // 日付(MS-DOS 形式)
});

test('XML の文字列・列の名前・シリアル値', () => {
  assert.equal(xmlText('a<b>&"c"\u0001\u0008d\te￾'), 'a&lt;b&gt;&amp;&quot;c&quot;d\te');
  assert.equal(xmlText('😀'), '😀');
  assert.deepEqual([0, 25, 26, 27, 51, 52, 701, 702].map(colName), ['A', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  assert.equal(excelSerial(Date.UTC(1970, 0, 1)), 25569);
  assert.equal(excelSerial(Date.UTC(2026, 9, 5, 12)), 46300.5);
});

test('CSV: RFC 4180 の引用と式の注入対策', () => {
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('a"b'), '"a""b"');
  assert.equal(csvField('a\nb'), '"a\nb"');
  assert.equal(csvField('a\rb'), '"a\rb"');
  assert.equal(csvField('plain 日本語'), 'plain 日本語');
  for (const s of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) assert.equal(neutralize(s), `'${s}`);
  for (const s of ['1=1', 'a@b', ' =x', '']) assert.equal(neutralize(s), s);
});

const at = (iso) => Date.parse(iso);
const row = (o = {}) => ({ start: at('2026-10-04T23:30:00Z'), end: at('2026-10-05T00:10:00Z'), minutes: 40, project: 'web', tool: 'Claude Code', title: 'タイトル', tasks: '', commits: 2, model: 'claude-opus-5-5', tokens: 1234, usd: 0.5, sessionId: 's1', ...o });

test('CSV: BOM・CRLF・tz の時刻・数値には印を付けない', () => {
  const rows = [row({ title: '=HYPERLINK("http://evil.example","x")', project: '-p', tasks: '@me, ABC-1', usd: null }), row({ title: '改行\nあり, "引用"', tokens: 0, commits: 0 })];
  const csv = toCsv(rows, { timeZone: 'Asia/Tokyo' });
  assert.ok(csv.startsWith('﻿日付,開始,終了,作業時間(分),'));
  assert.ok(csv.endsWith('\r\n'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0].split(',').length, COLUMNS.length);
  assert.equal(lines[1], `2026-10-05,2026-10-05 08:30:00,2026-10-05 09:10:00,40.0,'-p,Claude Code,"'=HYPERLINK(""http://evil.example"",""x"")","'@me, ABC-1",2,claude-opus-5-5,1234,,s1`);
  assert.equal(lines[2], '2026-10-05,2026-10-05 08:30:00,2026-10-05 09:10:00,40.0,web,Claude Code,"改行\nあり, ""引用""",,0,claude-opus-5-5,0,0.5000,s1');
});

test('.xlsx: 見出しは太字で固定、日付は日付のセル、文字列はインライン文字列', () => {
  const buf = buildXlsx({
    sheetName: '作業/記録',
    columns: [{ header: '日付', type: 'date', width: 12 }, { header: '時刻', type: 'datetime' }, { header: '名前', type: 'text', width: 30 }, { header: '数', type: 'int' }, { header: 'USD', type: 'dec4' }],
    rows: [[46300, 46300.5, '=1+1 <tag> & "q"', 3, 0.1234], [null, undefined, '', NaN, null]],
  });
  const f = unzip(buf);
  assert.deepEqual(Object.keys(f), ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']);
  assert.match(f['xl/workbook.xml'], /<sheet name="作業_記録" sheetId="1" r:id="rId1"\/>/);
  const sheet = f['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<dimension ref="A1:E3"\/>/);
  assert.match(sheet, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(sheet, /<col min="1" max="1" width="12" customWidth="1"\/><col min="2" max="2" width="12" customWidth="1"\/><col min="3" max="3" width="30"/);
  assert.match(sheet, /<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">日付<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="A2" s="2"><v>46300<\/v><\/c><c r="B2" s="3"><v>46300.5<\/v><\/c>/);
  assert.match(sheet, /<c r="C2" t="inlineStr"><is><t xml:space="preserve">=1\+1 &lt;tag&gt; &amp; &quot;q&quot;<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="D2" s="6"><v>3<\/v><\/c><c r="E2" s="5"><v>0.1234<\/v><\/c>/);
  assert.doesNotMatch(sheet, /<f>/); // 式は書かない
  assert.match(sheet, /<row r="3"><c r="C3" t="inlineStr"><is><t xml:space="preserve"><\/t><\/is><\/c><\/row>/); // 空のセルは省く
  const styles = f['xl/styles.xml'];
  assert.match(styles, /<numFmt numFmtId="164" formatCode="yyyy-mm-dd"\/>/);
  assert.match(styles, /<font><b\/>/);
  assert.match(f['[Content_Types].xml'], /PartName="\/xl\/styles\.xml"/);
});

// ---- ログからの行の組み立て(区間ごと・セッションごと)と、API・CLI ----
const line = (id, o) => JSON.stringify({ sessionId: id, cwd: '/nonexistent/web', ...o });
const user = (id, ts, content) => line(id, { type: 'user', timestamp: ts, message: { role: 'user', content } });
let n = 0;
const asst = (id, ts, model = 'claude-opus-5-5', usage = { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 1000 }) => line(id, { type: 'assistant', timestamp: ts, message: { id: `m${++n}`, model, stop_reason: 'end_turn', content: [], usage } });
const commit = (id, ts, hash, subject) => [
  line(id, { type: 'assistant', timestamp: ts, message: { id: `m${++n}`, model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu${n}`, name: 'Bash', input: { command: `git commit -m "${subject}"` } }] } }),
  line(id, { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu${n}`, content: `[main ${hash}] ${subject}\n 1 file changed` }] } }),
];

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-log-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proj = path.join(root, 'projects', '-web');
  await mkdir(proj, { recursive: true });
  // s1: 2026-10-05 の 01:00〜01:20 と 03:00〜03:40(UTC)。1つめの区間に1件、2つめに1件のコミット。2つめは別のモデル
  const s1 = [
    '{"type":"ai-title","aiTitle":"=ログイン修正 ghp_abcdefghijklmnopqrstuvwxyz0123"}',
    user('s1', '2026-10-05T01:00:00Z', 'ログインを直す'),
    asst('s1', '2026-10-05T01:10:00Z'),
    ...commit('s1', '2026-10-05T01:15:00Z', 'aaaaaaa', '修正'),
    asst('s1', '2026-10-05T01:20:00Z'),
    user('s1', '2026-10-05T03:00:00Z', '続き'),
    asst('s1', '2026-10-05T03:30:00Z', 'claude-haiku-4-5', { input_tokens: 10, output_tokens: 20 }),
    ...commit('s1', '2026-10-05T03:35:00Z', 'bbbbbbb', '続き'),
    asst('s1', '2026-10-05T03:40:00Z', 'claude-haiku-4-5', { input_tokens: 10, output_tokens: 20 }),
  ];
  await writeFile(path.join(proj, 's1.jsonl'), s1.join('\n'));
  // 範囲の外(前の日)
  await writeFile(path.join(proj, 's0.jsonl'), [user('s0', '2026-10-01T01:00:00Z', '前の作業'), asst('s0', '2026-10-01T01:30:00Z')].join('\n'));
  const store = new Store({ projectsDir: path.join(root, 'projects'), cacheDir: path.join(root, 'cache') });
  await store.scan();
  return { root, store };
}

test('行の組み立て: 区間ごとのトークン・コスト・コミットの合計はセッションと一致し、文字列は伏せる', async (t) => {
  const { store } = await setup(t);
  const sessions = store.sessions();
  const range = { from: Date.parse('2026-10-05T00:00:00Z'), to: Date.parse('2026-10-06T00:00:00Z') };
  const segs = exportRows(sessions, { ...range, subagents: store.subagentIndex() });
  assert.deepEqual(segs.map((r) => [new Date(r.start).toISOString(), r.minutes, r.commits, r.model, r.tokens]), [
    ['2026-10-05T01:00:00.000Z', 20, 1, 'claude-opus-5-5', 2 * 1300],
    ['2026-10-05T03:00:00.000Z', 40, 1, 'claude-haiku-4-5', 2 * 30],
  ]);
  for (const r of segs) {
    assert.equal(r.title, '=ログイン修正 [GITHUB_TOKEN]');
    assert.equal(r.project, 'web');
    assert.equal(r.tool, 'Claude Code');
  }
  const [whole] = exportRows(sessions, { ...range, unit: 'session' });
  assert.equal(whole.minutes, 60);
  assert.equal(whole.commits, 2);
  assert.equal(whole.tokens, segs[0].tokens + segs[1].tokens);
  assert.ok(Math.abs(whole.usd - sessions.find((s) => s.id === 's1').cost.usd) < 1e-4);
  assert.ok(Math.abs(whole.usd - (segs[0].usd + segs[1].usd)) < 1e-4);
  assert.equal(whole.model, 'claude-opus-5-5, claude-haiku-4-5');
  // 単価のわからないモデルだけなら USD は空
  const [unknown] = exportRows([{ id: 'x', project: 'p', segments: [{ start: '2026-10-05T00:00:00Z', end: '2026-10-05T00:10:00Z' }], usage: { '2026-10-05T00|mystery-model||': [1, 2, 0, 0, 0, 0] } }]);
  assert.equal(unknown.usd, null);
  assert.equal(unknown.tokens, 3);
});

test('API: /api/export.csv と /api/export.xlsx(添付ファイル・期間・tz)', async (t) => {
  const { store } = await setup(t);
  const server = createServer(store, { env: {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const q = 'from=2026-10-05&to=2026-10-05&tz=Asia%2FTokyo';
  const csv = await fetch(`${base}/api/export.csv?${q}`);
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8; header=present');
  assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="work-log-20261004-20261005.csv"');
  const text = await csv.text();
  assert.doesNotMatch(text, /ghp_/);
  const lines = text.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^2026-10-05,2026-10-05 10:00:00,2026-10-05 10:20:00,20\.0,web,Claude Code,'=ログイン修正 \[GITHUB_TOKEN\],,1,claude-opus-5-5,2600,/);
  const ses = await (await fetch(`${base}/api/export.csv?${q}&unit=session`)).text();
  assert.equal(ses.trim().split('\r\n').length, 2);

  const x = await fetch(`${base}/api/export.xlsx?${q}`);
  assert.equal(x.status, 200);
  assert.equal(x.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(x.headers.get('content-disposition'), 'attachment; filename="work-log-20261004-20261005.xlsx"');
  const sheet = unzip(Buffer.from(await x.arrayBuffer()))['xl/worksheets/sheet1.xml'];
  // 日付は東京の 2026-10-05、開始は 10:00(シリアル値)
  assert.match(sheet, new RegExp(`<c r="A2" s="2"><v>${excelSerial(Date.UTC(2026, 9, 5))}</v></c><c r="B2" s="3"><v>${excelSerial(Date.UTC(2026, 9, 5, 10))}</v></c>`));
  assert.match(sheet, /=ログイン修正 \[GITHUB_TOKEN\]/); // .xlsx では ' を付けない(文字列のセル)
  assert.doesNotMatch(sheet, /ghp_/);

  assert.equal((await fetch(`${base}/api/export.csv?unit=day`)).status, 400);
  assert.equal((await fetch(`${base}/api/export.csv?from=2020-01-01&to=2026-01-01`)).status, 400);
  assert.equal((await fetch(`${base}/api/export.pdf`)).status, 404);
});

test('CLI: work-log export --csv / --xlsx --out', async (t) => {
  const { root } = await setup(t);
  const env = { ...process.env, WORKLOG_PROJECTS_DIR: path.join(root, 'projects'), WORKLOG_CACHE_DIR: path.join(root, 'cache'), HOME: root, TZ: 'UTC' };
  const run = (...a) => promisify(execFile)(process.execPath, [CLI, 'export', ...a], { env });
  const { stdout } = await run('--csv', '--from', '2026-10-01', '--to', '2026-10-05', '--per', 'session');
  const lines = stdout.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^2026-10-01,2026-10-01 01:00:00,/);
  const out = path.join(root, 'w.xlsx');
  const r = await run('--xlsx', '--from', '2026-10-01', '--to', '2026-10-05', '--out', out);
  assert.match(r.stderr, /3行/);
  assert.match(unzip(await readFile(out))['xl/worksheets/sheet1.xml'], /<dimension ref="A1:M4"\/>/);
  await assert.rejects(run('--from', '2026-10-01'), /--csv \/ --xlsx/);
  await assert.rejects(run('--csv', '--per', 'week'), /--per/);
});
