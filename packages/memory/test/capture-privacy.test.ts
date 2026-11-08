import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretForms } from '../../core/src/redact/secrets.ts';
import { capture, type CaptureInput } from '../src/capture.ts';

test('fixture repository ed25519 keys and private terms cannot reach the stored lesson', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-memory-privacy-'));
  try {
    const pair = generateKeyPairSync('ed25519');
    const privateJwk = pair.privateKey.export({ format: 'jwk' });
    assert.ok(privateJwk.d && privateJwk.x);
    // Solana keypair representation: the 32-byte seed followed by the public key.
    const keypair = Buffer.concat([Buffer.from(privateJwk.d, 'base64url'), Buffer.from(privateJwk.x, 'base64url')]);
    assert.equal(keypair.length, 64);
    const forms = secretForms(keypair).map(form => form.text);
    const identifier = 'Private' + randomBytes(16).toString('hex');
    const seed = randomBytes(24).toString('hex');
    const rpc = `https://private.invalid/rpc?token=${randomBytes(24).toString('hex')}`;
    const planted = [...forms, identifier, seed, rpc];
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'lib.rs'), `// ${identifier}\nconst SEED: &str = "${seed}";\n// ${rpc}\n// anchor-lang AccountNotInitialized\n`);
    writeFileSync(join(root, 'keypair.txt'), forms.join('\n'), { mode: 0o600 });
    const diff = [readFileSync(join(root, 'src', 'lib.rs'), 'utf8'), readFileSync(join(root, 'keypair.txt'), 'utf8')].join('\n');
    const check = (text: string) => {
      for (const value of planted) for (let offset = 0; offset + 8 <= value.length; offset++) {
        // Do not put the secret or a substring in assertion diagnostics.
        assert.equal(text.includes(value.slice(offset, offset + 8)), false, 'private substring escaped');
      }
    };
    const digest = 'a'.repeat(64);
    const input: CaptureInput = {
      failure: { reason: 'failed', failureDigest: digest, output: 'error: AccountNotInitialized incompatible argument types', reopenCount: 1 },
      closure: { closed: true, executionIdentity: digest, evidence: { passed: true, mode: 'offline-snapshot', specificationDigest: digest, codeDigest: digest, verifierDigest: digest, snapshotDigest: digest, at: '2026-11-08T00:00:00Z' } },
      applicability: { framework: 'anchor', versions: { 'anchor-lang': '1.2.2', '@solana/kit': null, surfpool: null, agave: null, rustc: null, node: null }, range: {} },
      diff, installSalt: 's'.repeat(32), secretForms: forms,
      vocabulary: new Set('anchor-lang accountnotinitialized error incompatible argument types'.split(' ')),
    };
    const result = await capture(input);
    assert.ok(result);
    const { lesson } = result;
    const payload = { signature: lesson.signature, applicability: lesson.applicability, body: lesson.body, fixKey: lesson.fixKey, evidence: lesson.evidence[0] };
    check(JSON.stringify(payload));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
