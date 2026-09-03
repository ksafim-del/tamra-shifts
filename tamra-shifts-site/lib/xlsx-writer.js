'use strict';
/*
 * Minimal, zero-dependency .xlsx WRITER — the mirror image of xlsx-truth.js's zero-dependency
 * .xlsx READER, and for the same reason: this deploy pipeline (manual copy-paste into GitHub,
 * Render's build server, a sandbox that can't always reach the npm registry) makes adding a new
 * package like "xlsx"/SheetJS/exceljs risky, so this hand-rolls just enough of the OOXML format
 * to produce a workbook Excel/Google Sheets/LibreOffice will open correctly.
 *
 * Supports exactly what the app needs and nothing more: one or more sheets, each a simple grid
 * of string/number cells, right-to-left sheet view (for Hebrew), and per-column widths. Cells use
 * inline strings (t="inlineStr") instead of a shared-strings table, which is legal OOXML and
 * avoids a whole extra part + index bookkeeping.
 */

/* ============================================================ */
/* CRC-32 (needed for the ZIP local/central-directory headers,   */
/* even when entries are stored uncompressed)                    */
/* ============================================================ */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/* ============================================================ */
/* minimal ZIP writer (store method — no compression; the files  */
/* here are tiny, so this trades a little size for simplicity)   */
/* ============================================================ */
function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  files.forEach((f) => {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // bit 11: UTF-8 name
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  });
  const centralStart = offset;
  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

/* ============================================================ */
/* OOXML (spreadsheet XML) generation                             */
/* ============================================================ */
function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// 0-based column index -> spreadsheet column letters (0 -> A, 26 -> AA, ...)
function colLetters(n) {
  let s = '';
  n += 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function buildSheetXml(rows, colWidths) {
  let rowsXml = '';
  rows.forEach((row, r) => {
    const rNum = r + 1;
    let cellsXml = '';
    row.forEach((val, c) => {
      const ref = colLetters(c) + rNum;
      if (val == null || val === '') {
        cellsXml += '<c r="' + ref + '"/>';
      } else if (typeof val === 'number' && isFinite(val)) {
        cellsXml += '<c r="' + ref + '"><v>' + val + '</v></c>';
      } else {
        cellsXml += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEscape(val) + '</t></is></c>';
      }
    });
    rowsXml += '<row r="' + rNum + '">' + cellsXml + '</row>';
  });
  const colsXml = colWidths && colWidths.length
    ? '<cols>' + colWidths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>'
    : '';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetViews><sheetView rightToLeft="1" workbookViewId="0"/></sheetViews>'
    + colsXml
    + '<sheetData>' + rowsXml + '</sheetData>'
    + '</worksheet>';
}

const CONTENT_TYPES_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>';
const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
  + '</Relationships>';

/**
 * Builds a complete .xlsx file as a Buffer.
 * @param {Array<{name: string, rows: Array<Array<string|number|null>>, colWidths?: number[]}>} sheets
 *   `name` is the visible sheet-tab name (keep it short — Excel caps sheet names at 31 chars).
 */
function buildWorkbook(sheets) {
  const files = [];
  let contentTypes = CONTENT_TYPES_HEAD;
  let workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  let sheetsXml = '';

  sheets.forEach((sheet, i) => {
    const idx = i + 1;
    files.push({ name: 'xl/worksheets/sheet' + idx + '.xml', data: Buffer.from(buildSheetXml(sheet.rows, sheet.colWidths), 'utf8') });
    contentTypes += '<Override PartName="/xl/worksheets/sheet' + idx + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    workbookRels += '<Relationship Id="rId' + idx + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + idx + '.xml"/>';
    // sheet names must be XML-safe and <=31 chars; truncate defensively rather than produce an invalid file
    const safeName = xmlEscape(sheet.name).slice(0, 31);
    sheetsXml += '<sheet name="' + safeName + '" sheetId="' + idx + '" r:id="rId' + idx + '"/>';
  });
  contentTypes += '</Types>';
  workbookRels += '</Relationships>';

  const workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheets>' + sheetsXml + '</sheets>'
    + '</workbook>';

  files.push({ name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') });
  files.push({ name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') });
  files.push({ name: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') });
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') });

  return makeZip(files);
}

module.exports = { buildWorkbook };
