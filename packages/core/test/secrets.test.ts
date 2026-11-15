import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDeepRedactor,
  decodeBase58,
  encodeBase58,
  redactSecret,
  scanForSecret,
  scanForSecrets,
  secretForms,
  type SecretEncoding,
} from '../src/redact/secrets.ts';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Independent BigInt implementation, used to cross-check the byte-array version. */
function referenceBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  let value = 0n;
  for (let i = zeros; i < bytes.length; i += 1) value = value * 256n + BigInt(bytes[i] ?? 0);
  let out = '';
  while (value > 0n) {
    out = `${ALPHABET[Number(value % 58n)] ?? ''}${out}`;
    value /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

const ASCII = (text: string): Uint8Array => Uint8Array.from([...text].map((char) => char.charCodeAt(0)));

const KEY_32 = Uint8Array.from(Array.from({ length: 32 }, (_, index) => (index * 7 + 3) % 256));
const KEY_64 = Uint8Array.from(Array.from({ length: 64 }, (_, index) => (index * 13 + 5) % 256));

test('base58 known vectors', () => {
  const cases: Array<[Uint8Array, string]> = [
    [new Uint8Array(0), ''],
    [Uint8Array.from([0]), '1'],
    [Uint8Array.from([0, 0]), '11'],
    [Uint8Array.from([0, 1]), '12'],
    [Uint8Array.from([1]), '2'],
    [ASCII('hello world'), 'StV1DL6CwTryKyV'],
    [ASCII('Hello World!'), '2NEpo7TZRRrLZSi2U'],
    [new Uint8Array(32), '1'.repeat(32)],
    [Uint8Array.from(Array.from({ length: 32 }, (_, index) => index)), '1thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE'],
  ];
  for (const [bytes, expected] of cases) {
    assert.equal(encodeBase58(bytes), expected, JSON.stringify([...bytes]));
    assert.equal(referenceBase58(bytes), expected, 'reference disagrees');
  }
});

test('base58 round-trips arbitrary byte strings', () => {
  for (const bytes of [KEY_32, KEY_64, ASCII('oms'), Uint8Array.from([0, 0, 255, 0, 7])]) {
    const decoded = decodeBase58(encodeBase58(bytes));
    assert.ok(decoded !== null);
    assert.deepEqual(decoded, bytes);
  }
});

test('base58 decoding rejects characters outside the alphabet', () => {
  assert.equal(decodeBase58('0OIl'), null);
  assert.deepEqual(decodeBase58(''), new Uint8Array(0));
});

test('secretForms covers hex, base58, base64 and JSON array', () => {
  const forms = new Map<SecretEncoding, string>(secretForms(KEY_32).map((form) => [form.encoding, form.text]));
  assert.equal(forms.get('hex'), Buffer.from(KEY_32).toString('hex'));
  assert.equal(forms.get('hex_upper'), Buffer.from(KEY_32).toString('hex').toUpperCase());
  assert.equal(forms.get('base58'), encodeBase58(KEY_32));
  assert.equal(forms.get('base64'), Buffer.from(KEY_32).toString('base64'));
  assert.equal(
    forms.get('base64url'),
    Buffer.from(KEY_32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  );
  assert.equal(forms.get('json_array'), `[${Array.from(KEY_32).join(',')}]`);
  assert.equal(forms.get('csv'), Array.from(KEY_32).join(','));
});

test('the scanner finds every encoding of a planted secret', () => {
  for (const secret of [KEY_32, KEY_64]) {
    const forms = secretForms(secret);
    for (const form of forms) {
      const haystack = `prefix ${form.text} suffix`;
      const scan = scanForSecret(haystack, secret);
      assert.equal(scan.found, true, `${form.encoding} not found`);
      assert.ok(
        scan.hits.some((hit) => hit.index === haystack.indexOf(form.text)),
        `${form.encoding} not located: ${scan.hits.map((hit) => `${hit.encoding}@${hit.index}`).join(',')}`,
      );
      for (const hit of scan.hits) {
        assert.ok(hit.excerpt.length > 0);
        assert.ok(hit.index >= 0);
      }
    }
  }
});

test('the scanner matches JSON arrays with arbitrary whitespace', () => {
  const numbers = Array.from(KEY_32).join(' ,\n  ');
  const scan = scanForSecret(`wallet = [ ${numbers} ]`, KEY_32);
  assert.equal(scan.found, true);
  assert.ok(scan.hits.some((hit) => hit.encoding === 'json_array'));
});

test('scanner negative controls', () => {
  const stable =
    'You are oms. Skills: anchor-vault | Vault patterns | 0f1e2d. sha256: 9f2c1b4a7d6e5f8091a2b3c4d5e6f708';
  assert.deepEqual(scanForSecret(stable, KEY_32), { found: false, hits: [], shortFormsSkipped: false });
  assert.equal(scanForSecrets(stable, [KEY_32, KEY_64]).found, false);
});

test('scanForSecrets reports hits from any of several secrets', () => {
  const hex = secretForms(KEY_32).find((form) => form.encoding === 'hex')?.text ?? '';
  const base64 = secretForms(KEY_64).find((form) => form.encoding === 'base64')?.text ?? '';
  const haystack = `a ${hex} b ${base64}`;
  const scan = scanForSecrets(haystack, [KEY_32, KEY_64]);
  assert.equal(scan.found, true);
  const encodings = scan.hits.map((hit) => hit.encoding);
  assert.ok(encodings.includes('hex'), encodings.join(','));
  assert.ok(encodings.includes('base64'), encodings.join(','));
  assert.ok(scan.hits.some((hit) => hit.index === haystack.indexOf(hex)));
  assert.ok(scan.hits.some((hit) => hit.index === haystack.indexOf(base64)));
});

test('a very short secret is reported as skipped, not silently matched', () => {
  const scan = scanForSecret('anything at all', Uint8Array.from([1, 2]));
  assert.equal(scan.found, false);
  assert.equal(scan.shortFormsSkipped, true);
});

test('redaction removes every encoding and reports the hits', () => {
  const forms = secretForms(KEY_32);
  const haystack = forms.map((form) => `<${form.text}>`).join('\n');
  const redacted = redactSecret(haystack, KEY_32);
  assert.ok(redacted.hits.length >= 4);
  assert.equal(redacted.text.includes('[REDACTED]'), true);
  assert.deepEqual(scanForSecret(redacted.text, KEY_32).found, false);
  for (const form of forms) assert.equal(redacted.text.includes(form.text), false, form.encoding);
});

test('deep redactor walks nested values, arrays and keys', () => {
  const hex = secretForms(KEY_32).find((form) => form.encoding === 'hex')?.text ?? '';
  const redact = createDeepRedactor([KEY_32]);
  const input = {
    seq: 1,
    time: '2025-10-29T01:02:03.000Z',
    type: 'tool_call',
    nested: { blob: `0x${hex}`, list: [`${hex}`, 42, null] },
    [hex]: 'secret key',
  };
  const output = redact(input) as unknown as typeof input;
  const text = JSON.stringify(output);
  assert.equal(text.includes(hex), false, 'no encoding may survive');
  assert.equal(scanForSecret(text, KEY_32).found, false);
  assert.equal((output.nested.list[0] as string).includes('[REDACTED]'), true);
  assert.equal(output.nested.list[1], 42);
  assert.equal(output.nested.list[2], null);
  assert.equal(output.seq, 1, 'non-string fields are untouched');
  assert.equal(output.type, 'tool_call');
});

test('deep redactor handles cycles without throwing', () => {
  const hex = secretForms(KEY_32).find((form) => form.encoding === 'hex')?.text ?? '';
  const redact = createDeepRedactor([KEY_32]);
  const cyclic: Record<string, unknown> = { blob: hex };
  cyclic.self = cyclic;
  const output = redact(cyclic);
  assert.equal(JSON.stringify(output).includes(hex), false);
});

test('scanning and redaction are deterministic', () => {
  const haystack = `x ${encodeBase58(KEY_64)} y`;
  assert.deepEqual(scanForSecret(haystack, KEY_64), scanForSecret(haystack, KEY_64));
  assert.deepEqual(redactSecret(haystack, KEY_64), redactSecret(haystack, KEY_64));
});

test('deep redactor removes exact known structured bytes before JSON serialization', () => {
  const redact = createDeepRedactor<unknown>([KEY_32]);
  for (const value of [
    Array.from(KEY_32),
    new Uint8Array(KEY_32),
    Buffer.from(KEY_32),
    Buffer.from(KEY_32).toJSON(),
    JSON.parse(JSON.stringify(new Uint8Array(KEY_32))),
  ]) {
    const output = redact({ nested: [value], ordinary: [1, 2, 3] });
    assert.equal(scanForSecret(JSON.stringify(output), KEY_32).found, false);
    assert.deepEqual(output, { nested: ['[REDACTED]'], ordinary: [1, 2, 3] });
  }
});

test('deep redactor preserves shared nonsecret values and deep unrelated data', () => {
  const shared = { value: 'not secret' };
  let deep: unknown = { secret: Array.from(KEY_32), ordinary: 'keep me' };
  for (let i = 0; i < 40; i += 1) deep = { child: deep };
  const redact = createDeepRedactor<unknown>([KEY_32]);
  assert.deepEqual(redact({ left: shared, right: shared }), { left: shared, right: shared });
  const serialized = JSON.stringify(redact(deep));
  assert.ok(serialized.includes('keep me'));
  assert.ok(serialized.includes('[REDACTED]'));
  assert.ok(!serialized.includes('depth limit'));
});
