import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applicability } from '../src/applicability.ts';

const runtime = { surfpool: null, agave: null, rustc: null, node: null };
test('resolved versions cannot smuggle identifiers or URLs into capture applicability', () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-applicability-security-'));
  try {
    for (const version of ['private_canary_identifier', 'https://rpc.invalid/?token=private_canary', '1.2.3-private_canary', '1.2.3-privatecanary']) {
      writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@solana/kit': { version } } }));
      assert.throws(() => applicability(root, runtime), error => error instanceof Error && !error.message.includes(version));
    }
    writeFileSync(join(root, 'package-lock.json'), '{}');
    writeFileSync(join(root, 'Cargo.lock'), '[[package]]\nname = "anchor-lang"\nversion = "private_canary_identifier"\n');
    assert.throws(() => applicability(root, runtime), /version/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('public release and numeric rc pins remain exact', () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-applicability-public-'));
  try {
    for (const version of ['8.6.0', '8.6.0-rc.1', '8.6.0-beta.2', '8.6.0-alpha.3']) {
      writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@solana/kit': { version } } }));
      assert.equal(applicability(root, runtime).versions['@solana/kit'], version);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
