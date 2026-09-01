'use strict';
/*
 * דוח שעות אמת — parses the .xlsx hours-summary export produced by the company's
 * fingerprint clock-in/clock-out system, and matches it against our own employees
 * by full name.
 *
 * Zero-dependency by design: this sandbox/deploy pipeline cannot always reach the
 * npm registry, and the manual copy-paste-into-GitHub deploy workflow makes adding
 * a new dependency risky (it has to successfully install on Render's build server
 * too). So this file includes its own minimal .xlsx (OOXML/ZIP) reader built only
 * on node:zlib, instead of depending on a package like "xlsx"/SheetJS.
 *
 * IMPORTANT — the real export format has NO night-hours or Shabbat breakdown.
 * It's a monthly pre-aggregated summary per employee, already split by the
 * punch-clock system itself into: regular hours, overtime tier א' (first tier),
 * overtime tier ב' (second tier), and "exceptional" hours. There is nothing in
 * the file that lets us reconstruct a night/Shabbat split — so the "truth" report
 * surfaces exactly those columns, not the site's own regular/night/shabbat/overtime
 * buckets.
 */

const zlib = require('node:zlib');

/* ============================================================ */
/* zero-dependency .xlsx (ZIP + minimal XML) reader              */
/* ============================================================ */

function readZipEntries(buf) {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  const start = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('not_a_zip');
  const entryCount = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  const entries = {};
  const CD_SIG = 0x02014b50;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(cdOffset) !== CD_SIG) break;
    const compMethod = buf.readUInt16LE(cdOffset + 10);
    const compSize = buf.readUInt32LE(cdOffset + 20);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localHeaderOffset = buf.readUInt32LE(cdOffset + 42);
    const name = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen);
    entries[name] = { compMethod, compSize, localHeaderOffset };
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }

  function readEntry(name) {
    const e = entries[name];
    if (!e) return null;
    const lh = e.localHeaderOffset;
    if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('bad_local_header');
    const nameLen = buf.readUInt16LE(lh + 26);
    const extraLen = buf.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + nameLen + extraLen;
    const raw = buf.slice(dataStart, dataStart + e.compSize);
    if (e.compMethod === 0) return raw;
    if (e.compMethod === 8) return zlib.inflateRawSync(raw);
    throw new Error('unsupported_compression_' + e.compMethod);
  }

  return { names: Object.keys(entries), readEntry };
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  const siRe = /<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const inner = m[1];
    const tRe = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
    let t, text = '';
    while ((t = tRe.exec(inner))) text += t[1];
    strings.push(decodeXmlEntities(text));
  }
  return strings;
}

function colLetterToIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

function parseSheet(xml, sharedStrings) {
  const sparse = [];
  const rowRe = /<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rAttr = /(?:^|\s)r="(\d+)"/.exec(rm[1]);
    const rowNum = rAttr ? parseInt(rAttr[1], 10) : (sparse.length + 1);
    const rowXml = rm[2];
    const cellRe = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
    let cm;
    const rowArr = [];
    while ((cm = cellRe.exec(rowXml))) {
      const attrs = cm[1];
      const inner = cm[2] || '';
      const refM = /(?:^|\s)r="([A-Z]+)\d+"/.exec(attrs);
      const colIdx = refM ? colLetterToIndex(refM[1]) : rowArr.length;
      const typeM = /(?:^|\s)t="([a-zA-Z]+)"/.exec(attrs);
      const type = typeM ? typeM[1] : 'n';
      let value = null;
      if (type === 's') {
        const vM = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner);
        value = vM ? (sharedStrings[parseInt(vM[1], 10)] || '') : '';
      } else if (type === 'inlineStr') {
        const tM = /<(?:\w+:)?t[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/.exec(inner);
        value = tM ? decodeXmlEntities(tM[1]) : '';
      } else if (type === 'str' || type === 'b') {
        const vM = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner);
        value = vM ? decodeXmlEntities(vM[1]) : '';
      } else {
        const vM = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner);
        value = vM ? Number(vM[1]) : null;
      }
      rowArr[colIdx] = value;
    }
    sparse[rowNum - 1] = rowArr;
  }
  let maxLen = 0;
  for (let i = 0; i < sparse.length; i++) if (sparse[i]) maxLen = Math.max(maxLen, sparse[i].length);
  const dense = [];
  for (let i = 0; i < sparse.length; i++) {
    const r = sparse[i] || [];
    const out = new Array(maxLen).fill(null);
    for (let j = 0; j < r.length; j++) out[j] = r[j] === undefined ? null : r[j];
    dense.push(out);
  }
  return dense;
}

function readWorkbook(buf) {
  const zip = readZipEntries(buf);
  function text(name) {
    const raw = zip.readEntry(name);
    return raw ? raw.toString('utf8').replace(/^﻿/, '') : null;
  }
  const workbookXml = text('xl/workbook.xml');
  if (!workbookXml) throw new Error('not_xlsx');
  const relsXml = text('xl/_rels/workbook.xml.rels') || '';
  const sstXml = text('xl/sharedStrings.xml');
  const sharedStrings = sstXml ? parseSharedStrings(sstXml) : [];

  const sheetRe = /<(?:\w+:)?sheet\b([^>]*?)\/?>(?:<\/(?:\w+:)?sheet>)?/g;
  const sheets = [];
  let sm;
  while ((sm = sheetRe.exec(workbookXml))) {
    const attrs = sm[1];
    const nameM = /(?:^|\s)name="([^"]*)"/.exec(attrs);
    const ridM = /(?:^|\s)r:id="([^"]*)"/.exec(attrs);
    if (nameM && ridM) sheets.push({ name: decodeXmlEntities(nameM[1]), rid: ridM[1] });
  }
  const relRe = /<Relationship\b([^>]*)\/>/g;
  const relMap = {};
  let rl;
  while ((rl = relRe.exec(relsXml))) {
    const attrs = rl[1];
    const idM = /(?:^|\s)Id="([^"]*)"/.exec(attrs);
    const targetM = /(?:^|\s)Target="([^"]*)"/.exec(attrs);
    if (idM && targetM) relMap[idM[1]] = targetM[1];
  }
  function resolveTarget(target) {
    if (target.charAt(0) === '/') return target.slice(1);
    return 'xl/' + target;
  }
  return {
    sheetNames: sheets.map(s => s.name),
    getSheet(name) {
      const s = sheets.find(x => x.name === name);
      if (!s) return null;
      const target = relMap[s.rid];
      if (!target) return null;
      const xml = text(resolveTarget(target));
      if (!xml) return null;
      return parseSheet(xml, sharedStrings);
    },
  };
}

/* ============================================================ */
/* domain-specific: "true hours" attendance-export parsing        */
/* ============================================================ */

// Column headers exactly as produced by the fingerprint clock-in/clock-out system's export.
const HEADERS = {
  id: "ת.ז./מס' זיהוי",
  firstName: 'שם',
  fullName: 'שם משפחה', // despite the literal "last name" label, this column holds the full Hebrew name
  workDays: 'ימי עבודה',
  totalHours: 'סה"כ שעות',
  regular: 'שעות רגילות',
  overtimeA: "שעות נוספות א'",
  overtimeB: "שעות נוספות ב'",
  exceptional: 'שעות חריגות',
};

function num(v) {
  if (typeof v === 'number') return v;
  if (v == null || v === '') return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

// Strips quotes/gershayim and collapses whitespace so "עלי חגאזי " and 'עלי חגאזי'
// (or a stray extra space from data entry) still match each other and the site's names.
function normalizeName(s) {
  if (!s) return '';
  return String(s).replace(/["'׳״]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Parses the raw .xlsx buffer into a list of per-employee rows as reported by the
 * attendance system, using whichever sheet carries the expected headers (prefers
 * the decimal-format sheet — "תצורה עשרונית" — when both are present, since decimal
 * hours are simplest to add up).
 */
function parseTruthWorkbook(buf) {
  const wb = readWorkbook(buf);
  if (!wb.sheetNames.length) throw new Error('no_sheets');

  const candidateOrder = wb.sheetNames.slice().sort((a, b) => {
    const aDecimal = a.indexOf('עשרונית') !== -1 ? 0 : 1;
    const bDecimal = b.indexOf('עשרונית') !== -1 ? 0 : 1;
    return aDecimal - bDecimal;
  });

  let sheetUsed = null, rows = null, headerRowIdx = -1, header = null;
  for (const name of candidateOrder) {
    const r = wb.getSheet(name);
    if (!r || !r.length) continue;
    const idx = r.findIndex(row => row && row.indexOf(HEADERS.id) !== -1);
    if (idx !== -1) { sheetUsed = name; rows = r; headerRowIdx = idx; header = r[idx]; break; }
  }
  if (!rows) throw new Error('header_not_found');

  const colIdx = {};
  Object.keys(HEADERS).forEach((key) => { colIdx[key] = header.indexOf(HEADERS[key]); });
  if (colIdx.id === -1 || colIdx.fullName === -1) throw new Error('missing_columns');

  const employees = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const idCell = r[colIdx.id];
    if (idCell == null || idCell === '') continue;
    const idStr = String(idCell).trim();
    if (idStr.indexOf('סיכום') === 0) break; // "סיכום כללי:" grand-total row terminates the table
    const fullNameCell = r[colIdx.fullName];
    if (!fullNameCell || !String(fullNameCell).trim()) continue; // branch-total row has no name — skip
    employees.push({
      id: idStr,
      firstName: colIdx.firstName !== -1 ? (r[colIdx.firstName] || '') : '',
      fullName: String(fullNameCell).trim(),
      workDays: num(r[colIdx.workDays]),
      totalHours: num(r[colIdx.totalHours]),
      regular: num(r[colIdx.regular]),
      overtimeA: num(r[colIdx.overtimeA]),
      overtimeB: num(r[colIdx.overtimeB]),
      exceptional: colIdx.exceptional !== -1 ? num(r[colIdx.exceptional]) : 0,
    });
  }
  return { sheetUsed, employees };
}

module.exports = { readWorkbook, parseTruthWorkbook, normalizeName, HEADERS };
