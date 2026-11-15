/**
 * Error taxonomy for oms-signer.
 *
 * Rule: an error message is *public data*. It may name a code, a cluster, a
 * public address or a lamport amount. It may never contain keypair material,
 * the signer socket token, or a raw upstream exception message (upstream
 * messages can echo the input they failed to parse, e.g. JSON.parse).
 */

export type SignerErrorCode =
  | 'E_BAD_REQUEST'
  | 'E_MALFORMED_TX'
  | 'E_TX_TOO_LARGE'
  | 'E_PRESIGNED'
  | 'E_MULTISIG_UNSUPPORTED'
  | 'E_LOOKUP_UNSUPPORTED'
  | 'E_PROFILE'
  | 'E_LIFETIME'
  | 'E_PROGRAM_NOT_ALLOWED'
  | 'E_ACCOUNT_NOT_ALLOWED'
  | 'E_SPEND_PER_TX'
  | 'E_SPEND_CUMULATIVE'
  | 'E_LEDGER'
  | 'E_UNKNOWN_RESERVATION'
  | 'E_RESERVATION_CLOSED'
  | 'E_AUTH'
  | 'E_KEYPAIR'
  | 'E_KEYPAIR_EXISTS'
  | 'E_KEYPAIR_WRITE'
  | 'E_KEYPAIR_DIR_INSECURE'
  | 'E_INTERNAL';

export class SignerError extends Error {
  readonly code: SignerErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: SignerErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SignerError';
    this.code = code;
    this.details = details;
  }
}

export function isSignerError(value: unknown): value is SignerError {
  return value instanceof SignerError;
}

/**
 * Collapse any thrown value into a (code, message) pair that is safe to emit.
 * `scrub` is applied at the I/O boundary as well; this is defense in depth.
 */
export function toPublicError(
  error: unknown,
  scrub: (s: string) => string,
): { code: SignerErrorCode; message: string } {
  if (isSignerError(error)) {
    return { code: error.code, message: scrub(error.message) };
  }
  // Never forward message/stack of unknown errors: they are not audited.
  return { code: 'E_INTERNAL', message: 'internal signer error (details suppressed)' };
}
