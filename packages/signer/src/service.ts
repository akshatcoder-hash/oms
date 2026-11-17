import { PROTOCOL_VERSION } from './constants.ts';
import { toBase58 } from './encoding.ts';
import { SignerError, toPublicError } from './errors.ts';
import { assertIssuedKeypair, type LoadedKeypair } from './keypair.ts';
import { SpendLedger, type ReservationView } from './ledger.ts';
import type { Logger, Trace } from './output.ts';
import { evaluatePolicy, validatePolicyConfig, type PolicyConfig } from './policy.ts';
import { ProfileRpc } from './profile.ts';
import { safeJson } from './secret.ts';
import { attachSignature, decodeUnsignedTransaction, type DecodedUnsignedTransaction } from './tx.ts';

export type Channel = 'engine' | 'tui';
export interface ServiceOptions {
  config: PolicyConfig;
  keypair: LoadedKeypair;
  ledger: SpendLedger;
  logger: Logger;
  trace: Trace;
  testHooks?: {
    afterDecode?: (decoded: DecodedUnsignedTransaction) => void;
    beforeSign?: (decoded: DecodedUnsignedTransaction) => void;
    afterSignaturePersisted?: () => void;
  };
}
export interface HandleResult {
  line: string;
  response: Record<string, unknown>;
}
export interface SignerService {
  handle(channel: Channel, raw: string): Promise<HandleResult>;
  status(): Record<string, unknown>;
  reconcile(reservationId: string): Promise<ReservationView>;
  readonly signerAddress: string;
}

export function createSignerService(options: ServiceOptions): SignerService {
  assertIssuedKeypair(options.keypair);
  validatePolicyConfig(options.config);
  const config = structuredClone(options.config);
  const { keypair, ledger, logger, trace } = options;
  const { secret, address: signerAddress } = keypair;
  const rpc = new ProfileRpc(keypair.profile);
  if (rpc.id !== keypair.profileId) throw new SignerError('E_PROFILE', 'issued profile identity mismatch');
  // One queue covers both host reconciliation and all socket requests, preventing
  // a never-broadcast release racing with an in-flight signature operation.
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  }
  function status(): Record<string, unknown> {
    return {
      status: 'ok',
      signerAddress,
      alias: keypair.alias,
      profileId: rpc.id,
      developmentOnly: true,
      spend: ledger.toJSON(),
      capabilities: { canSign: true, canReconcile: true },
    };
  }
  async function reconcile(id: string): Promise<ReservationView> {
    const record = ledger.reservation(id);
    if (!record) throw new SignerError('E_UNKNOWN_RESERVATION', 'unknown reservation');
    if (record.profileId !== rpc.id)
      throw new SignerError('E_PROFILE', 'reservation belongs to a different trusted profile');
    if (record.outcome === 'confirmed' || record.outcome === 'never-broadcast') return record;
    // Signature metadata is fsync'd before any capability leaves the process.
    // Therefore a reservation without it is provably never broadcast by us.
    const outcome =
      record.signature === null ? 'never-broadcast' : await rpc.reconcile(record.signature, record.lifetime);
    const updated = ledger.recordReconciliation(id, outcome);
    trace.record({ event: 'reconciled', reservationId: id, outcome: updated.outcome, profileId: rpc.id });
    return updated;
  }
  async function dispatch(channel: Channel, raw: string): Promise<HandleResult> {
    let reqId: string | undefined;
    function respond(body: Record<string, unknown>): HandleResult {
      const response = { v: PROTOCOL_VERSION, ...body, ...(reqId === undefined ? {} : { reqId }) };
      return { response, line: safeJson(response, secret) };
    }
    try {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new SignerError('E_BAD_REQUEST', 'message must be valid JSON');
      }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new SignerError('E_BAD_REQUEST', 'message must be an object');
      const msg = value as Record<string, unknown>;
      if (typeof msg.reqId === 'string') reqId = msg.reqId;
      const allowed: Record<string, string[]> = {
        hello: [],
        status: [],
        lifetime: [],
        sign: ['transaction'],
        reconcile: ['reservationId'],
      };
      if (
        typeof msg.type !== 'string' ||
        !Object.hasOwn(allowed, msg.type) ||
        Object.keys(msg).some((k) => !['type', 'reqId', ...allowed[msg.type as string]!].includes(k))
      )
        throw new SignerError('E_BAD_REQUEST', 'unsupported request field or message type');
      if (msg.type === 'hello' || msg.type === 'status') return respond(status());
      if (msg.type === 'lifetime') return respond({ status: 'ok', profileId: rpc.id, lifetime: await rpc.lifetime() });
      if (msg.type === 'reconcile') {
        if (typeof msg.reservationId !== 'string') throw new SignerError('E_BAD_REQUEST', 'reservation id is required');
        const record = await reconcile(msg.reservationId);
        return respond({
          status: 'ok',
          reservationId: record.reservationId,
          outcome: record.outcome,
          spend: ledger.toJSON(),
        });
      }
      const decoded = decodeUnsignedTransaction(msg.transaction);
      options.testHooks?.afterDecode?.(decoded);
      const previous = ledger.find(decoded.digest);
      if (previous && previous.profileId !== rpc.id)
        throw new SignerError('E_PROFILE', 'reservation belongs to another profile');
      const lifetime = await rpc.validateLifetime(decoded, previous?.lifetime);
      const decision = evaluatePolicy({ decoded, signerAddress, config });
      const quotedFee = await rpc.fee(decoded.messageBase64, lifetime);
      decision.outflow.feeLamports = Math.max(decision.outflow.feeLamports, quotedFee);
      decision.outflow.totalLamports = decision.outflow.outboundLamports + decision.outflow.feeLamports;
      if (
        decision.outflow.feeLamports > config.feeCapLamports ||
        !Number.isSafeInteger(decision.outflow.totalLamports) ||
        decision.outflow.totalLamports > config.spend.perTxLamports
      )
        throw new SignerError('E_SPEND_PER_TX', 'full trusted fee/outflow exceeds the configured cap');
      const reservation = ledger.reserve({
        txDigest: decoded.digest,
        lamports: decision.outflow.totalLamports,
        messageBase64: decoded.messageBase64,
        profileId: rpc.id,
        lifetime,
      });
      if (reservation.outcome === 'expired-proven-absent' || reservation.outcome === 'never-broadcast')
        throw new SignerError('E_RESERVATION_CLOSED', 'transaction identity is closed; use a new transaction lifetime');
      let signature = reservation.signature;
      if (signature === null) {
        options.testHooks?.beforeSign?.(decoded);
        const bytes = secret.sign(decoded.messageBytes);
        attachSignature(decoded, signerAddress, bytes);
        signature = toBase58(bytes);
        ledger.recordSignature(reservation.reservationId, signature);
        options.testHooks?.afterSignaturePersisted?.();
      }
      trace.record({
        event: 'signed',
        channel,
        digest: decoded.digest,
        reservationId: reservation.reservationId,
        profileId: rpc.id,
        totalLamports: decision.outflow.totalLamports,
      });
      logger.log('info', 'development_signed', { reservationId: reservation.reservationId, profileId: rpc.id });
      return respond({
        status: 'signed',
        signerAddress,
        profileId: rpc.id,
        signature,
        digest: decoded.digest,
        reservationId: reservation.reservationId,
        lifetime: reservation.lifetime,
        ...decision.outflow,
        spend: ledger.toJSON(),
      });
    } catch (error) {
      const publicError = toPublicError(error, secret.scrub);
      logger.log('warn', 'request_rejected', { code: publicError.code });
      return respond({ status: 'error', ...publicError });
    }
  }
  return {
    handle: (channel, raw) => exclusive(() => dispatch(channel, raw)),
    status,
    reconcile: (id) => exclusive(() => reconcile(id)),
    signerAddress,
  };
}
