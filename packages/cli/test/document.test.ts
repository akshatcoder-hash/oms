import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FileDocument, MAX_DOCUMENT_BYTES, MAX_HISTORY_ENTRIES } from '../src/tui/document.ts';

test('untouched source and a local replacement preserve exact UTF-8 text', () => {
  const original = '\ufeff\talpha  \r\nβ\nlast\t';
  const document = new FileDocument(original);
  assert.equal(document.text, original);
  assert.equal(document.dirty, false);
  document.select(original.indexOf('alpha'), original.indexOf('alpha') + 5);
  document.insert('界');
  assert.equal(document.text, '\ufeff\t界  \r\nβ\nlast\t');
  assert.equal(document.dirty, true);
  document.undo();
  assert.equal(document.text, original);
  assert.equal(document.dirty, false);
  document.redo();
  assert.equal(document.text, '\ufeff\t界  \r\nβ\nlast\t');
});

test('movement, selection and deletion operate on whole graphemes and CRLF', () => {
  const document = new FileDocument('e\u0301👩🏽‍💻界\r\nx');
  document.move('right');
  assert.equal(document.cursor, 2);
  document.move('right', true);
  assert.equal(document.selectedText, '👩🏽‍💻');
  document.insert('🌱');
  assert.equal(document.text, 'e\u0301🌱界\r\nx');
  document.backspace();
  assert.equal(document.text, 'e\u0301界\r\nx');
  document.move('right');
  document.deleteForward();
  assert.equal(document.text, 'e\u0301界x');
  assert.throws(() => document.select(1, 1), /grapheme/i);
});

test('undo and redo restore reverse selections and invalidate abandoned redo', () => {
  const document = new FileDocument('first\r\nlast');
  document.select(11, 7);
  document.insert('tail');
  document.undo();
  assert.equal(document.cursor, 7);
  assert.equal(document.anchor, 11);
  assert.equal(document.selectedText, 'last');
  document.redo();
  assert.equal(document.text, 'first\r\ntail');
  document.undo();
  document.insert('other');
  document.redo();
  assert.equal(document.text, 'first\r\nother');
});

test('markSaved records the saved snapshot without clearing later edits', () => {
  const document = new FileDocument('a');
  document.select(1, 1);
  document.insert('b');
  const snapshot = document.text;
  document.insert('c');
  document.markSaved(snapshot);
  assert.equal(document.text, 'abc');
  assert.equal(document.dirty, true);
  document.undo();
  assert.equal(document.text, 'ab');
  assert.equal(document.dirty, false);
});

test('oversized or malformed edits fail atomically and history is bounded', () => {
  assert.throws(() => new FileDocument('界'.repeat(MAX_DOCUMENT_BYTES)), /limit/i);
  assert.throws(() => new FileDocument('\ud800'), /unicode|surrogate/i);
  const document = new FileDocument('x'.repeat(MAX_DOCUMENT_BYTES));
  document.select(0, 0);
  assert.throws(() => document.insert('a'), /limit/i);
  assert.equal(document.text.length, MAX_DOCUMENT_BYTES);
  assert.equal(document.dirty, false);
  const history = new FileDocument('');
  for (let i = 0; i < MAX_HISTORY_ENTRIES + 9; i++) history.insert('a');
  for (let i = 0; i < MAX_HISTORY_ENTRIES + 9; i++) history.undo();
  assert.equal(history.text, 'a'.repeat(9));
});

test('history payload eviction retains a coherent undo and redo chain', () => {
  const document = new FileDocument('a'.repeat(40 * 1024));
  for (let index = 0; index < 24; index++) {
    document.select(0, document.text.length);
    document.insert((index % 2 === 0 ? 'b' : 'c').repeat(40 * 1024));
  }
  for (let index = 0; index < 24; index++) document.undo();
  assert.notEqual(document.text[0], 'a');
  assert.equal(document.text.length, 40 * 1024);
  for (let index = 0; index < 24; index++) document.redo();
  assert.equal(document.text, 'c'.repeat(40 * 1024));
});

test('inserting a joining character keeps the resulting caret on a grapheme boundary', () => {
  const document = new FileDocument('👩💻');
  document.move('right');
  document.insert('\u200d');
  assert.equal(document.text, '👩‍💻');
  assert.equal(document.cursor, document.text.length);
  document.backspace();
  assert.equal(document.text, '');
  document.undo();
  document.undo();
  assert.equal(document.text, '👩💻');
});
