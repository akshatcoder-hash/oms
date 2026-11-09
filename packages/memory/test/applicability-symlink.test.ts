import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applicability } from '../src/applicability.ts';

const runtime = { surfpool: null, agave: null, rustc: null, node: null };
test('candidate lockfiles cannot follow symlinks to files outside the checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-applicability-symlink-'));
  try {
    const workspace = join(root, 'repo'); mkdirSync(workspace);
    const outside = join(root, 'host-private-fixture');
    writeFileSync(outside, '[[package]]\nname = "anchor-lang"\nversion = "1.2.2"\n');
    symlinkSync(outside, join(workspace, 'Cargo.lock'));
    assert.throws(() => applicability(workspace, runtime));
    rmSync(join(workspace, 'Cargo.lock'));
    writeFileSync(outside, '{"packages":{"node_modules/@solana/kit":{"version":"8.6.0"}}}');
    symlinkSync(outside, join(workspace, 'package-lock.json'));
    assert.throws(() => applicability(workspace, runtime));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an oversized candidate lockfile is refused before it is parsed', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'oms-applicability-size-'));
  try {
    writeFileSync(join(workspace, 'Cargo.lock'), Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    assert.throws(() => applicability(workspace, runtime), /larger than 4 MiB/);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
