import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/normalize.ts';

test('normalization stays idempotent when truncation meets codes or placeholders', () => {
  for (const tail of ['error[E0277]', 'error TS2345', '<path>', '<addr>', '<hex>', '<n>', '<id>']) {
    for (let padding = 180; padding < 245; padding++) {
      const result = normalize(`error[E0277]: ${'x'.repeat(padding)} ${tail}`, 'build', 'rustc');
      assert.ok(result.normalized.length <= 240);
      assert.deepEqual(normalize(result.normalized, 'build', 'rustc'), result, `${tail} at ${padding}`);
    }
  }
});

test('seeded mixed diagnostic properties preserve keys across normalization and private path changes', () => {
  let state = 1701;
  const next = () => state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  const pieces = [' /tmp/private/file.rs:123 ', ' C:\\private\\file.rs:35 ', " 'secretName' ",
    ' 18446744073709551615 ', ' 11111111111111111111111111111111 ', ' 0xabcdef1234567890 ',
    ' word ', ' <path> ', ' error[E0277] ', ' error TS2345 ', ' failed '];
  for (let sample = 0; sample < 1000; sample++) {
    let output = 'error[E0277]: ';
    for (let i = 0, count = next() % 80; i < count; i++) output += pieces[next() % pieces.length];
    const result = normalize(output, 'build', 'rustc');
    assert.equal(result.code, 'rustc:E0277');
    assert.ok(result.normalized.length <= 240);
    assert.deepEqual(normalize(result.normalized, 'build', 'rustc'), result, `seed 1701 sample ${sample}`);
    assert.equal(normalize(output.replaceAll('/tmp/private/file.rs:123', '/home/another/source.rs:987')
      .replaceAll('C:\\private\\file.rs:35', 'D:\\different\\source.rs:88'), 'build', 'rustc').key, result.key);
    assert.ok(!/private|secretName|abcdef1234567890|11111111111111111111111111111111/.test(result.normalized));
  }
});
