/**
 * Byte-codec helpers. Wraps @solana/kit codecs so the rest of the code does
 * not depend on kit's string-codec naming (`decode` = bytes -> string).
 */

import { getBase58Codec, getBase64Codec, getBase16Codec } from '@solana/kit';

const base58 = getBase58Codec();
const base64 = getBase64Codec();
const base16 = getBase16Codec();

export function toHex(bytes: Uint8Array): string {
  return base16.decode(bytes);
}

export function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(base16.encode(hex));
}

export function toBase58(bytes: Uint8Array): string {
  return base58.decode(bytes);
}

export function fromBase58(value: string): Uint8Array {
  return Uint8Array.from(base58.encode(value));
}

export function toBase64(bytes: Uint8Array): string {
  return base64.decode(bytes);
}

export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(base64.encode(value));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
