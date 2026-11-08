import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize, sha256, type SignatureKind, type SignatureTool } from '../src/normalize.ts';

const logs = JSON.parse(readFileSync(new URL('./fixtures/normalization-real.json', import.meta.url), 'utf8')) as {
  output: string; outputSha256: string; kind: SignatureKind; tool: SignatureTool;
}[];

test('pinned real run diagnostics normalize idempotently without private paths or locations', () => {
  for (const log of logs) {
    assert.equal(sha256(log.output), log.outputSha256);
    const result = normalize(log.output, log.kind, log.tool);
    assert.deepEqual(normalize(result.normalized, log.kind, log.tool), result);
    assert.ok(result.normalized.length <= 240);
    assert.ok(!result.normalized.includes('client.ts'));
    assert.ok(!result.normalized.includes('/trusted/'));
  }
});

test('real TypeScript diagnostic key is invariant under seeded path and location changes', () => {
  const log = logs.find(log => log.tool === 'tsc')!;
  const expected = normalize(log.output, log.kind, log.tool);
  assert.equal(expected.code, 'ts:2739');
  let seed = 91827;
  for (let i = 0; i < 100; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    for (const path of [`private${seed}.ts`, `src/private${seed}.tsx`, `/tmp/private${seed}/file.ts`, `C:\\private${seed}\\file.ts`]) {
      const output = log.output.replace('client.ts(76,4)', `${path}(${seed % 999 + 1},${seed % 80 + 1})`);
      const result = normalize(output, log.kind, log.tool);
      assert.equal(result.key, expected.key);
      assert.ok(!result.normalized.includes(`private${seed}`));
      assert.deepEqual(normalize(result.normalized, log.kind, log.tool), result);
    }
  }
});
