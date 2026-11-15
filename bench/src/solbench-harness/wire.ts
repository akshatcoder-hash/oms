/** Solana transaction wire format (legacy and v0), read just far enough to sign one slot and score top-level instructions. */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

/** `accounts` index the message's keys: static keys first, then lookup-table writable, then readonly (as the runtime orders them). */
export interface Instruction {
  programId: string;
  accounts: number[];
  data: Uint8Array;
}

export interface ParsedTransaction {
  version: 'legacy' | 0;
  /** Signature slots, in signer order; slot i belongs to signers[i]. */
  signatureCount: number;
  signers: string[];
  /** Byte offset of the message: every signature covers bytes [messageOffset, end). */
  messageOffset: number;
  staticKeys: string[];
  instructions: Instruction[];
}

/** Throws on anything that is not exactly one well-formed transaction. */
export function parseTransaction(bytes: Uint8Array): ParsedTransaction {
  let at = 0;
  const byte = () => {
    if (at >= bytes.length) throw new Error('transaction is truncated');
    return bytes[at++]!;
  };
  const take = (n: number) => {
    if (at + n > bytes.length) throw new Error('transaction is truncated');
    const out = bytes.subarray(at, at + n);
    at += n;
    return out;
  };
  const shortVec = () => {
    let value = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      const b = byte();
      value |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return value;
    }
    throw new Error('bad compact-u16');
  };
  const signatureCount = shortVec();
  take(signatureCount * 64);
  const messageOffset = at;
  let version: 'legacy' | 0 = 'legacy';
  if (bytes[at]! & 0x80) {
    if ((byte() & 0x7f) !== 0) throw new Error('only legacy and v0 transactions are supported');
    version = 0;
  }
  const required = byte();
  take(2);
  const keys = Array.from({ length: shortVec() }, () => base58(take(32)));
  if (required !== signatureCount || required > keys.length)
    throw new Error('signature count does not match the message header');
  take(32);
  const instructions = Array.from({ length: shortVec() }, () => {
    const programIndex = byte();
    const accounts = [...take(shortVec())];
    const data = take(shortVec());
    // Program ids cannot come from a lookup table, so an index past the static keys is invalid.
    const programId = keys[programIndex];
    if (!programId) throw new Error('program id index is outside the static account keys');
    return { programId, accounts, data: Uint8Array.from(data) };
  });
  if (version === 0) {
    for (let n = shortVec(); n > 0; n--) {
      take(32);
      take(shortVec());
      take(shortVec());
    }
  }
  if (at !== bytes.length) throw new Error('trailing bytes after the transaction');
  return { version, signatureCount, signers: keys.slice(0, required), messageOffset, staticKeys: keys, instructions };
}
