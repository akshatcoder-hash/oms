/**
 * Unsigned-transaction decode and normalisation.
 *
 * A "submit" from the engine is the wire bytes of a *unsigned* transaction:
 * base64 of `numSigs ++ zero-filled signature slots ++ message`. Any non-empty
 * signature slot means the transaction is partially or fully signed and is
 * rejected before anything else looks at it.
 */

import { createHash } from 'node:crypto';
import { getCompiledTransactionMessageDecoder, getTransactionDecoder, getTransactionEncoder } from '@solana/kit';
import { MAX_TRANSACTION_BYTES } from './constants.ts';
import { fromBase64 } from './encoding.ts';
import { SignerError } from './errors.ts';

export interface DecodedInstruction {
  programAddress: string;
  accountAddresses: string[];
  data: Uint8Array;
}

export interface SignatureSlot {
  address: string;
  /** true when the slot holds a real signature; must always be false here. */
  present: boolean;
}

export interface DecodedUnsignedTransaction {
  messageBytes: Uint8Array;
  messageBase64: string;
  /** SHA-256 of the exact signed message bytes, including all privilege headers. */
  digest: string;
  version: string | number;
  feePayer: string;
  signerAddresses: string[];
  accountKeys: readonly string[];
  instructions: DecodedInstruction[];
  signatureSlots: SignatureSlot[];
  numSignerAccounts: number;
  lifetimeToken: string | null;
}

interface RawParsedInstruction {
  programAddressIndex?: number;
  accountIndices?: readonly number[];
  data?: Uint8Array;
}

interface RawParsedMessage {
  version?: string | number;
  header?: { numSignerAccounts?: number; numReadonlySignerAccounts?: number; numReadonlyNonSignerAccounts?: number };
  staticAccounts?: readonly string[];
  lifetimeToken?: string;
  instructions?: readonly RawParsedInstruction[];
  addressTableLookups?: readonly unknown[];
}

export function decodeUnsignedTransaction(encoded: unknown): DecodedUnsignedTransaction {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new SignerError('E_BAD_REQUEST', 'transaction must be a non-empty base64 string');
  }
  if (encoded.length > 4096) {
    throw new SignerError('E_TX_TOO_LARGE', 'transaction exceeds the maximum encoded length');
  }

  let wire: Uint8Array;
  try {
    wire = fromBase64(encoded);
  } catch {
    throw new SignerError('E_MALFORMED_TX', 'transaction is not valid base64');
  }
  if (wire.length === 0) {
    throw new SignerError('E_MALFORMED_TX', 'transaction is empty');
  }
  if (wire.length > MAX_TRANSACTION_BYTES) {
    throw new SignerError('E_TX_TOO_LARGE', `transaction is ${wire.length} bytes; limit is ${MAX_TRANSACTION_BYTES}`);
  }

  let decoded: { signatures?: Record<string, Uint8Array | null>; messageBytes?: Uint8Array };
  try {
    decoded = getTransactionDecoder().decode(wire) as unknown as typeof decoded;
  } catch {
    throw new SignerError('E_MALFORMED_TX', 'transaction could not be decoded');
  }

  const signatures = decoded.signatures ?? {};
  const slots: SignatureSlot[] = Object.entries(signatures).map(([address, signature]) => ({
    address,
    present: signature !== null && signature !== undefined && signature.some((byte) => byte !== 0),
  }));

  if (slots.length === 0) {
    throw new SignerError('E_MALFORMED_TX', 'transaction has no signature slots');
  }
  if (slots.some((slot) => slot.present)) {
    throw new SignerError('E_PRESIGNED', 'transaction already carries one or more signatures');
  }

  const messageBytes = decoded.messageBytes;
  if (!(messageBytes instanceof Uint8Array) || messageBytes.length === 0) {
    throw new SignerError('E_MALFORMED_TX', 'transaction has no message');
  }

  let parsed: RawParsedMessage;
  try {
    parsed = getCompiledTransactionMessageDecoder().decode(messageBytes) as RawParsedMessage;
  } catch {
    throw new SignerError('E_MALFORMED_TX', 'transaction message could not be decoded');
  }

  const accountKeys = parsed.staticAccounts ?? [];
  const numSignerAccounts = parsed.header?.numSignerAccounts ?? 0;
  if (accountKeys.length === 0 || numSignerAccounts < 1) {
    throw new SignerError('E_MALFORMED_TX', 'transaction message has no fee payer');
  }
  if (numSignerAccounts > slots.length) {
    throw new SignerError('E_MALFORMED_TX', 'signature slot count is smaller than the signer count');
  }
  if (parsed.addressTableLookups && parsed.addressTableLookups.length > 0) {
    // Fail closed: with lookup tables the effective account list is not in the
    // bytes, so neither the allowlist nor the outflow analysis can be trusted.
    throw new SignerError(
      'E_LOOKUP_UNSUPPORTED',
      'versioned transaction uses address lookup tables; resolve accounts client-side before submitting',
    );
  }

  const instructions: DecodedInstruction[] = [];
  for (const instruction of parsed.instructions ?? []) {
    const programIndex = instruction.programAddressIndex;
    const programAddress = typeof programIndex === 'number' ? accountKeys[programIndex] : undefined;
    if (programAddress === undefined) {
      throw new SignerError('E_MALFORMED_TX', 'instruction references an unknown program index');
    }
    const accountAddresses: string[] = [];
    for (const index of instruction.accountIndices ?? []) {
      const address = accountKeys[index];
      if (address === undefined) {
        throw new SignerError('E_MALFORMED_TX', 'instruction references an unknown account index');
      }
      accountAddresses.push(address);
    }
    instructions.push({
      programAddress,
      accountAddresses,
      data: instruction.data instanceof Uint8Array ? instruction.data : new Uint8Array(),
    });
  }

  const feePayer = accountKeys[0] as string;
  const digest = createHash('sha256').update(messageBytes).digest('hex');

  return {
    messageBytes: Uint8Array.from(messageBytes),
    messageBase64: Buffer.from(messageBytes).toString('base64'),
    digest,
    version: parsed.version ?? 'legacy',
    feePayer,
    signerAddresses: accountKeys.slice(0, numSignerAccounts),
    accountKeys,
    instructions,
    signatureSlots: slots,
    numSignerAccounts,
    lifetimeToken: parsed.lifetimeToken ?? null,
  };
}

/** Rebuild the wire transaction with a signature placed in the matching slot. */
export function attachSignature(
  decoded: Pick<DecodedUnsignedTransaction, 'signatureSlots' | 'messageBytes'>,
  signerAddress: string,
  signature: Uint8Array,
): Uint8Array {
  if (signature.length !== 64) {
    throw new SignerError('E_INTERNAL', 'signature must be 64 bytes');
  }
  const slot = decoded.signatureSlots.find((candidate) => candidate.address === signerAddress);
  if (!slot) {
    throw new SignerError('E_BAD_REQUEST', 'the configured signer is not a signer of this transaction');
  }
  const signatures: Record<string, Uint8Array | null> = {};
  for (const candidate of decoded.signatureSlots) {
    signatures[candidate.address] = candidate.address === signerAddress ? Uint8Array.from(signature) : null;
  }
  return Uint8Array.from(
    getTransactionEncoder().encode({
      messageBytes: decoded.messageBytes,
      signatures,
    } as never),
  );
}
