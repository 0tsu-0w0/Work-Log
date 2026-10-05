// 依存なしの .xlsx(Office Open XML のスプレッドシート)の書き出し。シート1枚・インライン文字列・数値・日付だけの最小の形。
// ZIP も自前で組む(node:zlib の deflateRaw と CRC-32)。ファイル名は UTF-8(汎用フラグの 11 ビット目)。
// 中身: [Content_Types].xml / _rels/.rels / xl/workbook.xml / xl/_rels/workbook.xml.rels / xl/styles.xml / xl/worksheets/sheet1.xml
//   見出しの行は太字で固定(ウィンドウ枠の固定)、列の幅を指定、日付はシリアル値(1900 年基準)+ 日付の表示形式。
// 実際に確かめたもの(2026-10-05): `work-log export --xlsx` の出力を Python の openpyxl 3.1.5 と pandas 3.0.6(read_excel)で読み、
//   日付・開始・終了が datetime(表示形式 yyyy-mm-dd / yyyy-mm-dd hh:mm)・数値が数値・日本語がそのまま・見出しが太字・
//   枠の固定(A2)・列の幅になっていること。LibreOffice 25.8.7.3(Docker の linuxserver/libreoffice)の headless 変換で
//   .xlsx → .csv に変換でき、= で始まるタイトルが式として計算されずに文字列のまま出ること。`unzip -t` と Python の zipfile.testzip() で CRC。
// 確かめていないもの: Microsoft Excel・Google スプレッドシート・Numbers での表示。
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ZIP の日時(MS-DOS 形式、ローカル時刻の代わりに UTC)
function dosTime(ms) {
  const d = new Date(ms);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((Math.max(d.getUTCFullYear(), 1980) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

// files: [{ name, data: Buffer | string }] → ZIP の Buffer(すべて deflate で圧縮)
export function zip(files, { now = Date.now() } = {}) {
  const { time, date } = dosTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 展開に必要な版(2.0)
    local.writeUInt16LE(0x0800, 6); // ファイル名は UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // 30: 拡張フィールド長・32: コメント長・34: ディスク番号・36: 内部属性・38: 外部属性 はすべて 0
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// XML に書けない制御文字は取り除き、& < > " をエスケープする
const INVALID_XML = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;
export const xmlText = (v) => String(v ?? '').replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 0 → A、25 → Z、26 → AA
export function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// 表示形式(styles.xml の cellXfs の番号)
const STYLE = { text: 0, header: 1, date: 2, datetime: 3, dec1: 4, dec4: 5, int: 6 };
const MAX_CELL_CHARS = 32767; // Excel の1つのセルの上限

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const STYLES = `${HEAD}<styleSheet xmlns="${NS_MAIN}">
<numFmts count="4"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="166" formatCode="0.0"/><numFmt numFmtId="167" formatCode="0.0000"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// 日時(UTC のミリ秒)を Excel のシリアル値にする。表は tz の壁時計の時刻で見せるので、tz でのずれを足してから変換する
export function excelSerial(wallMs) {
  return wallMs / 86400000 + 25569; // 25569 = 1970-01-01(1900 年基準。1900-02-29 の扱いは Excel と同じになる範囲だけを使う)
}

// columns: [{ header, width, type: 'text' | 'int' | 'dec1' | 'dec4' | 'date' | 'datetime' }]
// rows: 値の配列の配列(text は文字列、数値型は number、date / datetime はシリアル値。null / undefined / NaN は空のセル)
export function buildXlsx({ sheetName = 'Sheet1', columns, rows, now = Date.now() }) {
  const cell = (ref, v, type, style) => {
    if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '';
    if (type === 'text' || typeof v !== 'number') {
      const s = String(v).slice(0, MAX_CELL_CHARS);
      return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${xmlText(s)}</t></is></c>`;
    }
    return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${v}</v></c>`;
  };
  const lastCol = colName(columns.length - 1);
  const xmlRows = [`<row r="1">${columns.map((c, i) => cell(`${colName(i)}1`, c.header, 'text', STYLE.header)).join('')}</row>`];
  rows.forEach((r, ri) => {
    const n = ri + 2;
    xmlRows.push(`<row r="${n}">${columns.map((c, i) => cell(`${colName(i)}${n}`, r[i], c.type, STYLE[c.type] || 0)).join('')}</row>`);
  });
  const sheet = `${HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">
<dimension ref="A1:${lastCol}${rows.length + 1}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 12}" customWidth="1"/>`).join('')}</cols>
<sheetData>${xmlRows.join('')}</sheetData>
</worksheet>`;
  const safeName = String(sheetName).replace(/[\[\]:*?/\\]/g, '_').slice(0, 31) || 'Sheet1';
  const files = [
    { name: '[Content_Types].xml', data: `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: `${HEAD}<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `${HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets><sheet name="${xmlText(safeName)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `${HEAD}<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ];
  return zip(files, { now });
}
