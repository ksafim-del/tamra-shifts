'use strict';
/*
 * Test-only helper: builds a minimal but structurally-real .xlsx (ZIP+XML) buffer in
 * memory, so tests can exercise lib/xlsx-truth.js's reader without ever checking in a
 * real attendance-export file (which would contain real employee names/ID numbers).
 * Never used by production code.
 */
const zlib = require('node:zlib');

function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  files.forEach(({ name, data }) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localEntry = Buffer.concat([local, nameBuf, compressed]);
    localParts.push(localEntry);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([central, nameBuf]));

    offset += localEntry.length;
  });

  const centralDir = Buffer.concat(centralParts);
  const localDir = Buffer.concat(localParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localDir.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localDir, centralDir, eocd]);
}

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function colIndexToLetter(idx) {
  let n = idx + 1, s = '';
  while (n > 0) { const rem = (n - 1) % 26; s = String.fromCharCode(65 + rem) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * Builds a fake but structurally-real .xlsx buffer with one sheet, given a 2D array of
 * cell values (strings become shared-string cells, numbers become numeric cells, null
 * cells are omitted).
 */
function buildFakeWorkbook(sheetName, rows) {
  const sharedStrings = [];
  const sstIndex = {};
  function sstIdxFor(str) {
    if (!(str in sstIndex)) { sstIndex[str] = sharedStrings.length; sharedStrings.push(str); }
    return sstIndex[str];
  }
  const rowsXml = rows.map((row, ri) => {
    const cellsXml = row.map((val, ci) => {
      if (val === null || val === undefined) return '';
      const ref = colIndexToLetter(ci) + (ri + 1);
      if (typeof val === 'number') return `<c r="${ref}" t="n"><v>${val}</v></c>`;
      const idx = sstIdxFor(String(val));
      return `<c r="${ref}" t="s"><v>${idx}</v></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cellsXml}</row>`;
  }).join('');

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
  const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">`
    + sharedStrings.map((s) => `<si><t>${xmlEscape(s)}</t></si>`).join('') + '</sst>';
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  // mirrors the real export's leading-slash absolute-style relationship targets
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet.xml"/></Relationships>`;
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`;

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(relsXml, 'utf8') },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sstXml, 'utf8') },
    { name: 'xl/worksheets/sheet.xml', data: Buffer.from(sheetXml, 'utf8') },
  ]);
}

const HEADER_ROW = [
  "ת.ז./מס' זיהוי", 'שם', 'שם משפחה', 'חוזה', 'ימי עבודה', 'היעדרות', 'שגיאות',
  'סה"כ שעות', 'סה"כ הפסקה בתשלום', 'סה"כ שעות לשכר', 'סה"כ שעות לשכר (עשרוני)',
  'שעות רגילות', "שעות נוספות א'", "שעות נוספות ב'", 'שעות חריגות',
];

function sampleRows() {
  return [
    ['דו"ח סיכום לחודש 08-2026 עבור סניף --- '],
    HEADER_ROW,
    ['999999999', 'תמרה דלקים 96 בע"מ', '', '1', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // branch total row: no full name
    ['206524720', 'MARWA', 'מרווה עאבד', '1', 21, 0, 0, 129.72, 0, 129.72, 129.72, 126.2, 2, 1.52, 0],
    ['300828415', 'ASAD JERIS', 'גריס אסעד', '1', 23, 0, 0, 187.82, 0, 187.82, 187.82, 175.9, 11.92, 0, 0],
    ['999999998', 'לא קיים', 'עובד לא קיים באתר', '1', 5, 0, 0, 40, 0, 40, 40, 40, 0, 0, 0],
    ['סיכום כללי:', '', '', '', null, null, null, null, null, null, null, null, null, null, null],
    ['ignored trailing row', '', '', '', 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0],
  ];
}

module.exports = { buildZip, buildFakeWorkbook, HEADER_ROW, sampleRows };
