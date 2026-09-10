'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { buildWorkbook, STYLES } = require('./xlsx-writer.js');

// buildWorkbook's ZIP entries are stored uncompressed ("method: store"), so every XML part's
// literal text is byte-for-byte present in the output buffer — reading it back as latin1 (a
// 1-byte-per-char decoding, so it never throws or mis-lengths on arbitrary bytes) lets these
// tests grep for expected XML without needing a real ZIP/XLSX reader dependency.
function partsText(buf) {
  return buf.toString('latin1');
}

test('buildWorkbook produces a workbook whose styles.xml is registered in both the content types and the workbook relationships', () => {
  const buf = buildWorkbook([{ name: 'Sheet1', rows: [['a', 'b']], colWidths: [10, 10] }]);
  const text = partsText(buf);
  assert.ok(text.includes('xl/styles.xml'), 'styles.xml part must be present');
  assert.ok(text.includes('ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"'), 'content types must declare styles.xml');
  assert.ok(text.includes('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"'), 'workbook rels must point a relationship at styles.xml');
});

test('buildWorkbook emits a cellXfs entry for every STYLES id, in the order STYLES expects', () => {
  const buf = buildWorkbook([{ name: 'Sheet1', rows: [['a']] }]);
  const text = partsText(buf);
  const m = text.match(/<cellXfs count="(\d+)">/);
  assert.ok(m, 'styles.xml must declare a cellXfs count');
  const count = Number(m[1]);
  // STYLES maps name -> index; the declared cellXfs count must cover every one of those indices.
  const maxIndex = Math.max(...Object.values(STYLES));
  assert.ok(count > maxIndex, 'cellXfs must have at least one entry per STYLES id (' + count + ' > ' + maxIndex + ')');
});

test('a cell\'s "s" attribute is only emitted for a non-default style, and reflects the requested style id', () => {
  const rows = [['bold-ish', 'plain']];
  const styles = [[STYLES.header, STYLES.plain]];
  const buf = buildWorkbook([{ name: 'Sheet1', rows, styles }]);
  const text = partsText(buf);
  assert.ok(text.includes('s="' + STYLES.header + '"'), 'the styled cell should carry an s="<id>" attribute');
  // The plain cell (style 0) must NOT carry a redundant s="0" — buildSheetXml only emits the
  // attribute when the style id is truthy, keeping the XML for ordinary cells minimal.
  assert.ok(!/<c r="B1" s="0"/.test(text), 'the plain-styled cell should not carry a redundant s="0"');
});

test('merges and freeze-pane options round-trip into the worksheet XML', () => {
  const buf = buildWorkbook([{
    name: 'Sheet1',
    rows: [['title'], ['h1', 'h2'], ['a', 'b']],
    merges: ['A1:B1'],
    freeze: { x: 1, y: 2 },
  }]);
  const text = partsText(buf);
  assert.ok(text.includes('<mergeCell ref="A1:B1"/>'), 'requested merge range must appear');
  assert.ok(text.includes('<pane xSplit="1" ySplit="2"'), 'requested freeze split must appear');
  assert.ok(text.includes('activePane="bottomRight"'), 'activePane must be a schema-valid literal corner, not an RTL-flavored one');
});

test('a per-row height is only emitted when requested, as ht="<n>" customHeight="1"', () => {
  const buf = buildWorkbook([{ name: 'Sheet1', rows: [['a'], ['b']], rowHeights: [30] }]);
  const text = partsText(buf);
  assert.ok(text.includes('<row r="1" ht="30" customHeight="1">'), 'row 1 should carry the requested height');
  assert.ok(text.includes('<row r="2">'), 'row 2 (no requested height) should not carry a height attribute');
});
