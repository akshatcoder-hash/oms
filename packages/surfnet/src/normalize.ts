/**
 * Error normalization: map raw Surfpool/RPC failures to a stable
 * {code, summary, hint} shape the engine and evaluator can branch on.
 *
 * Every mapping below is backed by a fixture captured from Surfpool 1.7.0
 * unless marked UNVERIFIED in the comment. See README.md for the list.
 */

/** Normalized error codes. */
export type SurfnetErrorCode =
  | 'missing-field'
  | 'account-not-found'
  | 'blockhash-not-found'
  | 'insufficient-funds'
  | 'program-not-deployed'
  | 'invalid-params'
  | 'method-not-found'
  | 'unreachable'
  | 'process-died'
  | 'unknown';

export interface NormalizedError {
  code: SurfnetErrorCode;
  /** One-line human summary, safe to show. */
  summary: string;
  /** Actionable next step for the model or the operator. */
  hint: string;
  /** Raw error text (message plus JSON-RPC error data), kept for triage. */
  raw: string;
}

export interface RawRpcFailure {
  message: string;
  /** JSON-RPC error code if the failure came from the RPC layer. */
  code?: number;
  /** JSON-RPC `error.data` payload (string or object). */
  data?: unknown;
}

function rawText(failure: RawRpcFailure): string {
  const data =
    failure.data === undefined
      ? ''
      : ` ${typeof failure.data === 'string' ? failure.data : JSON.stringify(failure.data)}`;
  return `${failure.message}${data}`.trim();
}

/** Extract `err` from a simulate/send failure payload (string or object form). */
function txErrKind(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const err = (data as { err?: unknown }).err;
  if (err === undefined || err === null) return undefined;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const keys = Object.keys(err as Record<string, unknown>);
    return keys[0];
  }
  return undefined;
}

/**
 * Normalize a raw RPC failure. Unknown errors pass through with the raw text
 * kept intact.
 */
export function normalizeError(failure: RawRpcFailure): NormalizedError {
  const raw = rawText(failure);
  const kind = txErrKind(failure.data);
  // The simulation message repeats the err kind; fold both into the haystack.
  const haystack = `${raw}${kind ? ` ${kind}` : ''}`;

  // serde "missing field `X`" family. The exact `missing field data` trigger
  // is UNVERIFIED on 1.7.0 (see README); the family is verified via
  // `surfnet_exportSnapshot` with missing params -> "missing field `scope`.".
  const missing = /missing field `?([^ `']+)'?/.exec(haystack);
  if (missing) {
    const field = missing[1] ?? 'unknown';
    return {
      code: 'missing-field',
      summary: `request body has the wrong shape: field \`${field}\` is missing`,
      hint:
        `the RPC call's params do not match the expected struct (missing \`${field}\`); ` +
        'fix the request shape rather than retrying',
      raw,
    };
  }

  // Fixture: -32002, data.err "AccountNotFound", message "Transaction
  // simulation failed: Attempt to debit an account but found no record of a
  // prior credit." (unfunded fee payer, offline 1.7.0).
  if (kind === 'AccountNotFound' || /no record of a prior credit/i.test(haystack)) {
    return {
      code: 'account-not-found',
      summary: 'an account the transaction needs (often the fee payer) does not exist',
      hint: 'seed the account first with surfnet_setAccount (lamports plus owner), then resend',
      raw,
    };
  }

  // Fixture: -32002, data.err "BlockhashNotFound", message "Transaction
  // simulation failed: Blockhash not found". Also fired spuriously by
  // sendTransaction without preflightCommitment on offline surfnets.
  if (kind === 'BlockhashNotFound' || /Blockhash not found/i.test(haystack)) {
    return {
      code: 'blockhash-not-found',
      summary: 'the transaction references a blockhash the surfnet does not know',
      hint:
        'fetch a fresh getLatestBlockhash and rebuild, and send with ' +
        '{preflightCommitment: "confirmed"} — without it offline surfpool reports ' +
        'BlockhashNotFound even for a valid blockhash',
      raw,
    };
  }

  // Fixture: data.err {"InsufficientFundsForRent":{"account_index":1}},
  // message "...insufficient funds for rent...".
  if (kind === 'InsufficientFundsForRent' || /insufficient (funds|lamports)/i.test(haystack)) {
    return {
      code: 'insufficient-funds',
      summary: 'an account would end below the rent-exempt minimum',
      hint:
        'fund the affected account above rent exemption with surfnet_setAccount, ' +
        'or close it instead of writing it',
      raw,
    };
  }

  // Fixture: simulate result value.err "InvalidProgramForExecution" for a
  // program id with no deployed code (offline 1.7.0).
  if (
    kind === 'InvalidProgramForExecution' ||
    kind === 'ProgramFailedToComplete' ||
    /program .* not (found|deployed)/i.test(haystack)
  ) {
    return {
      code: 'program-not-deployed',
      summary: 'the transaction invokes a program that is not deployed on this surfnet',
      hint:
        'in offline mode the program must come from the snapshot or be written with ' +
        'surfnet_writeProgram; in forked mode check that the program exists on the source network',
      raw,
    };
  }

  // Fixture: -32602 "Invalid pubkey 'notapubkey'" data "String is the wrong
  // size"; -32602 "Invalid params: invalid length 1, expected a tuple of
  // size 2."; -32602 "Invalid params: invalid type: map, expected a string.".
  if (failure.code === -32602 || /Invalid params|Invalid pubkey|invalid type/i.test(haystack)) {
    return {
      code: 'invalid-params',
      summary: 'the RPC call received malformed parameters',
      hint: 'fix the params shape (pubkey strings must be base58, tuples must be complete) and retry',
      raw,
    };
  }

  // Fixture: -32601 "Method not found".
  if (failure.code === -32601 || /Method not found/i.test(haystack)) {
    return {
      code: 'method-not-found',
      summary: 'the surfnet does not implement this RPC method',
      hint: 'check the Surfpool version (oms pins 1.7.0) and the method name',
      raw,
    };
  }

  return {
    code: 'unknown',
    summary: failure.message,
    hint: 'unclassified Surfpool error; triage from the raw text',
    raw,
  };
}

/**
 * Build a normalized error for a failure that did not come from the RPC
 * body (fetch-level connection failure, or the child process dying).
 */
export function normalizeTransportError(
  message: string,
  code: Extract<SurfnetErrorCode, 'unreachable' | 'process-died'>,
  hint: string,
): NormalizedError {
  return { code, summary: message, hint, raw: message };
}
