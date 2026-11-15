/**
 * Secret handling.
 *
 * `SecretMaterial` owns the raw ed25519 key bytes and never hands them out.
 * Callers can only:
 *   - ask for the public address,
 *   - ask it to sign a message,
 *   - ask it to scrub / detect its own byte patterns in text.
 *
 * `scrub()` is the single boundary used before anything is written to a
 * socket, a log file, a trace file or an error message.
 */

import { getBase58Codec, getBase64Codec } from '@solana/kit';
import { toHex } from './encoding.ts';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface SecretMaterial {
  readonly address: string;
  readonly publicKeyBytes: Uint8Array;
  /** Signs one message with the loaded key. Never returns or logs the key. */
  sign(message: Uint8Array): Uint8Array;
  /** Replaces every known byte-encoding of this key with `[REDACTED]`. */
  scrub(text: string): string;
  /** True if any known byte-encoding of this key appears in `text`. */
  contains(text: string | Uint8Array): boolean;
  /** The string forms used by `contains`; exposed for tests only. */
  readonly forms: readonly string[];
  toJSON(): string;
  toString(): string;
}

interface BuildOptions {
  keypairBytes: Uint8Array;
  seedBytes: Uint8Array;
  address: string;
  publicKeyBytes: Uint8Array;
  sign: (message: Uint8Array) => Uint8Array;
}

export const REDACTED = '[REDACTED]';

export function createSecretMaterial(options: BuildOptions): SecretMaterial {
  const keypairBytes = Uint8Array.from(options.keypairBytes);
  const seedBytes = Uint8Array.from(options.seedBytes);

  const b58 = getBase58Codec();
  const b64 = getBase64Codec();

  const literalForms: string[] = [];
  const regexes: RegExp[] = [];

  const addBytes = (bytes: Uint8Array): void => {
    const hex = toHex(bytes);
    const base58 = b58.decode(bytes);
    const base64 = b64.decode(bytes);
    const base64Url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const numbers = Array.from(bytes);

    literalForms.push(hex, hex.toUpperCase(), base58, base64, base64Url);
    regexes.push(
      new RegExp(escapeRegExp(hex), 'gi'),
      new RegExp(escapeRegExp(base58), 'g'),
      new RegExp(escapeRegExp(base64), 'g'),
      new RegExp(escapeRegExp(base64Url), 'g'),
      new RegExp(escapeRegExp(numbers.join(',')), 'g'),
      new RegExp(escapeRegExp(numbers.join(', ')), 'g'),
      // number arrays with any whitespace layout
      new RegExp('\\[\\s*' + numbers.map((n) => String(n)).join('\\s*,\\s*') + '\\s*\\]', 'g'),
      // bare comma separated numbers with any whitespace layout
      new RegExp(numbers.map((n) => String(n)).join('\\s*,\\s*'), 'g'),
    );
  };

  addBytes(keypairBytes);
  addBytes(seedBytes);

  // Anything that merely *looks* like raw key material, as defense in depth.
  // Thresholds sit above a 64-byte base58 signature (88 chars) and a 32-byte
  // base58 address (44 chars) so normal protocol data survives.
  const genericPatterns: readonly RegExp[] = [
    /\b[0-9a-fA-F]{128,}\b/g,
    /\b[1-9A-HJ-NP-Za-km-z]{100,}\b/g,
    /\b[A-Za-z0-9+/]{250,}={0,2}/g,
  ];

  const frozenForms: readonly string[] = Object.freeze([...literalForms]);

  return {
    address: options.address,
    publicKeyBytes: Uint8Array.from(options.publicKeyBytes),
    sign: options.sign,
    forms: frozenForms,
    scrub(text: string): string {
      if (typeof text !== 'string' || text.length === 0) return text;
      let out = text;
      for (const re of regexes) out = out.replace(re, REDACTED);
      for (const re of genericPatterns) out = out.replace(re, REDACTED);
      return out;
    },
    contains(text: string | Uint8Array): boolean {
      if (text instanceof Uint8Array) {
        if (text.length >= keypairBytes.length && indexOfBytes(text, keypairBytes) !== -1) return true;
        if (text.length >= seedBytes.length && indexOfBytes(text, seedBytes) !== -1) return true;
        return false;
      }
      for (const re of regexes) {
        re.lastIndex = 0;
        if (re.test(text)) return true;
      }
      return false;
    },
    toJSON(): string {
      return REDACTED;
    },
    toString(): string {
      return REDACTED;
    },
  };
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Serialize `value` to JSON with the secret scrubbed out of the result. */
export function safeJson(value: unknown, secret: SecretMaterial): string {
  let text: string;
  try {
    const seen = new WeakSet<object>();
    text = JSON.stringify(value ?? null, (_key, val: unknown) => {
      if (typeof val === 'bigint') return String(val);
      if (val && typeof val === 'object') {
        if (seen.has(val as object)) return '[circular]';
        seen.add(val as object);
      }
      return val;
    });
  } catch {
    text = '{"status":"error","code":"E_INTERNAL","message":"unserializable response"}';
  }
  return secret.scrub(text);
}
