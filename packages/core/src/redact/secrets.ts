/**
 * Secret scanning and redaction.
 *
 * Engine-side half of the "0 key bytes in context or traces" acceptance test
 * (SPEC section 9): the signer scans its own outputs, this scans everything the
 * engine emits, and it is also the trace redactor.
 *
 * Forms checked for a given byte string: hex (lower and upper), base58, base64
 * (standard and url-safe, padded and unpadded), JSON array and bare/spaced CSV.
 * Base58 is implemented here so the package keeps zero dependencies.
 *
 * Known limitation (same as the signer's scanner): a secret embedded inside a
 * longer payload is only caught when its own encoding appears verbatim. A base64
 * blob that concatenates other bytes around it is not aligned and cannot match.
 */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const BASE58_INDEX: ReadonlyMap<string, number> = new Map(
  [...BASE58_ALPHABET].map((char, index) => [char, index] as const),
);

export function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;

  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i] ?? 0;
    for (let d = 0; d < digits.length; d += 1) {
      const value = (digits[d] ?? 0) * 256 + carry;
      digits[d] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out += BASE58_ALPHABET[digits[i] ?? 0] ?? '';
  }
  return out;
}

/** Decode base58; returns null on any character outside the alphabet. */
export function decodeBase58(text: string): Uint8Array | null {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros += 1;

  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i += 1) {
    const char = text[i] ?? '';
    const value = BASE58_INDEX.get(char);
    if (value === undefined) return null;
    let carry = value;
    for (let b = 0; b < bytes.length; b += 1) {
      const current = (bytes[b] ?? 0) * 58 + carry;
      bytes[b] = current % 256;
      carry = Math.floor(current / 256);
    }
    while (carry > 0) {
      bytes.push(carry % 256);
      carry = Math.floor(carry / 256);
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[out.length - 1 - i] = bytes[i] ?? 0;
  return out;
}

export type SecretEncoding =
  | 'hex'
  | 'hex_upper'
  | 'base58'
  | 'base64'
  | 'base64url'
  | 'json_array'
  | 'csv';

export interface SecretForm {
  readonly encoding: SecretEncoding;
  readonly text: string;
}

export interface SecretHit {
  readonly encoding: SecretEncoding;
  readonly index: number;
  readonly excerpt: string;
}

export interface SecretScan {
  readonly found: boolean;
  readonly hits: SecretHit[];
  /** True when a form was too short to search for safely (short inline secrets). */
  readonly shortFormsSkipped: boolean;
}

/** Minimum form length to search for; shorter strings match by accident. */
const MIN_FORM_LENGTH = 8;

function base64Forms(bytes: Uint8Array): { standard: string; url: string } {
  const standard = Buffer.from(bytes).toString('base64');
  const url = standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { standard, url };
}

export function secretForms(bytes: Uint8Array): SecretForm[] {
  const hex = Buffer.from(bytes).toString('hex');
  const base64 = base64Forms(bytes);
  const numbers = Array.from(bytes);
  const forms: SecretForm[] = [
    { encoding: 'hex', text: hex },
    { encoding: 'hex_upper', text: hex.toUpperCase() },
    { encoding: 'base58', text: encodeBase58(bytes) },
    { encoding: 'base64', text: base64.standard },
    { encoding: 'base64url', text: base64.url },
    { encoding: 'json_array', text: `[${numbers.join(',')}]` },
    { encoding: 'csv', text: numbers.join(',') },
  ];
  return forms;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 8);
  const end = Math.min(text.length, index + length + 8);
  const raw = text.slice(start, end).replace(/\s+/g, ' ');
  return raw.length > 72 ? `${raw.slice(0, 69)}...` : raw;
}

interface CompiledForm {
  readonly encoding: SecretEncoding;
  readonly pattern: RegExp;
}

function compileForms(bytes: Uint8Array): { forms: CompiledForm[]; shortFormsSkipped: boolean } {
  const numbers = Array.from(bytes);
  const loose = numbers.map((n) => String(n)).join('\\s*,\\s*');
  const forms: CompiledForm[] = [];
  let shortFormsSkipped = false;

  for (const form of secretForms(bytes)) {
    if (form.text.length < MIN_FORM_LENGTH) {
      shortFormsSkipped = true;
      continue;
    }
    const source =
      form.encoding === 'json_array'
        ? `\\[\\s*${loose}\\s*\\]`
        : form.encoding === 'csv'
          ? loose
          : escapeRegExp(form.text);
    forms.push({ encoding: form.encoding, pattern: new RegExp(source, 'g') });
  }
  return { forms, shortFormsSkipped };
}

/** Find any known text encoding of `secretBytes` inside `haystack`. */
export function scanForSecret(haystack: string, secretBytes: Uint8Array): SecretScan {
  const { forms, shortFormsSkipped } = compileForms(secretBytes);
  const hits: SecretHit[] = [];
  const claimed = new Set<string>();
  for (const { encoding, pattern } of forms) {
    for (const match of haystack.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (match[0].length === 0) continue;
      const key = `${index}:${match[0].length}`;
      if (claimed.has(key)) continue;
      claimed.add(key);
      hits.push({ encoding, index, excerpt: excerpt(haystack, index, match[0].length) });
      break;
    }
  }
  hits.sort(compareHits);
  return { found: hits.length > 0, hits, shortFormsSkipped };
}

/** Scan for any of several secrets (different byte strings). */
export function scanForSecrets(haystack: string, secrets: readonly Uint8Array[]): SecretScan {
  const hits: SecretHit[] = [];
  let shortFormsSkipped = false;
  for (const secret of secrets) {
    const result = scanForSecret(haystack, secret);
    hits.push(...result.hits);
    shortFormsSkipped = shortFormsSkipped || result.shortFormsSkipped;
  }
  hits.sort(compareHits);
  return { found: hits.length > 0, hits, shortFormsSkipped };
}

function compareHits(a: SecretHit, b: SecretHit): number {
  if (a.index !== b.index) return a.index - b.index;
  if (a.encoding === b.encoding) return 0;
  return a.encoding < b.encoding ? -1 : 1;
}

/** Replace every known encoding of `secretBytes` with `[REDACTED]`. */
export function redactSecret(
  haystack: string,
  secretBytes: Uint8Array,
  replacement = '[REDACTED]',
): { text: string; hits: SecretHit[] } {
  const { forms } = compileForms(secretBytes);
  const hits: SecretHit[] = [];
  let text = haystack;
  for (const { encoding, pattern } of forms) {
    const single = new RegExp(pattern.source, 'g');
    text = text.replace(single, (match: string, offset: number) => {
      hits.push({ encoding, index: offset, excerpt: excerpt(haystack, offset, match.length) });
      return replacement;
    });
  }
  hits.sort(compareHits);
  return { text, hits };
}

/** Exact matches only: unrelated numeric arrays must remain intact. */
function isSecretBytes(value: object, secrets: readonly Uint8Array[]): boolean {
  let bytes: ArrayLike<unknown> | undefined;
  if (Array.isArray(value) || value instanceof Uint8Array) {
    bytes = value;
  } else {
    const record = value as Record<string, unknown>;
    if (record.type === 'Buffer' && Array.isArray(record.data) && Object.keys(record).length === 2) {
      bytes = record.data;
    } else {
      // JSON.stringify(Uint8Array) produces a numeric-key object.
      const keys = Object.keys(record);
      if (keys.length > 0 && keys.every((key, index) => key === String(index))) {
        bytes = { ...record, length: keys.length };
      }
    }
  }
  if (bytes === undefined) return false;
  const candidate = bytes;
  return secrets.some((secret) => secret.length > 0 && candidate.length === secret.length &&
    secret.every((byte, index) => candidate[index] === byte));
}

function scrubValue(value: unknown, secrets: readonly Uint8Array[], ancestors: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) text = redactSecret(text, secret).text;
    return text;
  }
  if (typeof value !== 'object' || value === null) return value;
  if (isSecretBytes(value, secrets)) return '[REDACTED]';
  if (ancestors.has(value)) return '[circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => scrubValue(item, secrets, ancestors));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      let safeKey = key;
      for (const secret of secrets) safeKey = redactSecret(safeKey, secret).text;
      Object.defineProperty(out, safeKey, {
        value: scrubValue(item, secrets, ancestors), enumerable: true, writable: true, configurable: true,
      });
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/** Scrub text and exact known structured bytes; cycles are explicitly marked. */
export function createDeepRedactor<T>(secrets: readonly Uint8Array[]): (value: T) => T {
  const known = secrets.map((secret) => new Uint8Array(secret));
  return (value: T): T => scrubValue(value, known, new WeakSet()) as T;
}
