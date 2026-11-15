/**
 * Profiles are host-authorized records, not facts inferred from key bytes.
 * The model cannot create or select one. Same-UID host code can replace keys,
 * records, binaries or RPC servers; private files and a live child registry do
 * not defend against that actor or attest a remote RPC operator's honesty.
 * Local launch configuration (including its endpoint) belongs to the trusted
 * OMS supervisor; the child registry prevents serialized/replayed PID claims.
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { SignerError } from './errors.ts';
import type { DecodedUnsignedTransaction } from './tx.ts';
import { SYSTEM_PROGRAM_ADDRESS } from './constants.ts';

/** Full 32-byte base58 hashes as returned by getGenesisHash; shortened chain identifiers never match a real RPC. */
export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const TESTNET_GENESIS = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY';
export type DevelopmentProfile =
  | { kind: 'devnet'; endpoint: string; genesisHash: string; authorization: 'user-approved' }
  | { kind: 'local'; endpoint: string; genesisHash: string; processId: string; pid: number };

const localProcesses = new Map<string, { child: ChildProcess; identity: string }>();

/** Host-only launcher: executable/arguments are trusted operator configuration, never protocol input. */
export function launchLocalProfile(options: { executable: string; args: string[]; endpoint: string; genesisHash: string }): { profile: DevelopmentProfile; process: ChildProcess } {
  const endpoint = new URL(options.endpoint);
  if (!['127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.protocol !== 'http:') throw new SignerError('E_PROFILE', 'local profile requires a literal loopback HTTP endpoint');
  if (!options.genesisHash || [DEVNET_GENESIS_HASH, MAINNET_GENESIS, TESTNET_GENESIS].includes(options.genesisHash)) throw new SignerError('E_PROFILE', 'local profile requires an isolated development genesis');
  const processId = randomUUID();
  const child = spawn(options.executable, options.args, { stdio: 'ignore', shell: false });
  child.once('error', () => localProcesses.delete(processId));
  if (!child.pid) throw new SignerError('E_PROFILE', 'local development process failed to start');
  const profile: DevelopmentProfile = { kind: 'local', endpoint: endpoint.href, genesisHash: options.genesisHash, processId, pid: child.pid };
  localProcesses.set(profile.processId, { child, identity: profileIdentity(profile) });
  child.once('exit', () => localProcesses.delete(profile.processId));
  return { profile: Object.freeze(profile), process: child };
}

export function validateProfile(value: unknown): DevelopmentProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SignerError('E_PROFILE', 'development profile is required');
  const p = value as Record<string, unknown>;
  if (typeof p.endpoint !== 'string' || typeof p.genesisHash !== 'string') throw new SignerError('E_PROFILE', 'profile endpoint and genesis are required');
  let url: URL;
  try { url = new URL(p.endpoint); } catch { throw new SignerError('E_PROFILE', 'invalid profile endpoint'); }
  if (url.username || url.password || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new SignerError('E_PROFILE', 'unsupported profile endpoint');
  if (url.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(url.hostname)) throw new SignerError('E_PROFILE', 'non-loopback development endpoints require HTTPS');
  if (p.kind === 'devnet' && p.authorization === 'user-approved' && p.genesisHash === DEVNET_GENESIS_HASH && Object.keys(p).sort().join(',') === 'authorization,endpoint,genesisHash,kind') {
    return Object.freeze({ kind: 'devnet', endpoint: url.href, genesisHash: DEVNET_GENESIS_HASH, authorization: 'user-approved' });
  }
  if (p.kind === 'local' && typeof p.processId === 'string' && typeof p.pid === 'number' && Object.keys(p).sort().join(',') === 'endpoint,genesisHash,kind,pid,processId') {
    const registered = localProcesses.get(p.processId);
    const child = registered?.child;
    if (!child || child.pid !== p.pid || child.exitCode !== null || child.signalCode !== null || child.killed || registered?.identity !== profileIdentity(p as DevelopmentProfile) || url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) throw new SignerError('E_PROFILE', 'local profile is not owned by a live OMS process');
    return Object.freeze({ kind: 'local', endpoint: url.href, genesisHash: p.genesisHash, processId: p.processId, pid: p.pid });
  }
  throw new SignerError('E_PROFILE', 'only authorized devnet or live OMS-owned local profiles are supported');
}

export function profileIdentity(profile: DevelopmentProfile): string {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}

export interface TransactionLifetime { blockhash: string; lastValidBlockHeight: number; validatedSlot: number }
export type ReconciledOutcome = 'unknown' | 'confirmed' | 'expired-proven-absent' | 'never-broadcast';

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new SignerError('E_PROFILE', 'trusted RPC returned an invalid integer');
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SignerError('E_PROFILE', 'trusted RPC returned an invalid object');
  return value as Record<string, unknown>;
}

/** No RPC method, endpoint, params, or cluster is taken from a model request. */
export class ProfileRpc {
  readonly profile: DevelopmentProfile;
  readonly id: string;
  #lifetimes = new Map<string, TransactionLifetime>();
  constructor(profile: DevelopmentProfile) { this.profile = validateProfile(profile); this.id = profileIdentity(this.profile); }
  private async call(method: string, params: unknown[] = []): Promise<unknown> {
    validateProfile(this.profile);
    try {
      const response = await fetch(this.profile.endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error();
      const body = object(await response.json());
      if (body.error || body.id !== 1 || !Object.hasOwn(body, 'result')) throw new Error();
      return body.result;
    } catch { throw new SignerError('E_PROFILE', 'trusted development RPC unavailable or invalid'); }
  }
  async assertIdentity(): Promise<void> {
    if (await this.call('getGenesisHash') !== this.profile.genesisHash) throw new SignerError('E_PROFILE', 'trusted RPC genesis differs from the authorized development profile');
  }
  async lifetime(): Promise<TransactionLifetime> {
    await this.assertIdentity();
    const latest = object(await this.call('getLatestBlockhash', [{ commitment: 'finalized' }]));
    const value = object(latest.value);
    if (typeof value.blockhash !== 'string' || !value.blockhash) throw new SignerError('E_LIFETIME', 'trusted RPC returned an invalid blockhash');
    const lifetime = { blockhash: value.blockhash, lastValidBlockHeight: integer(value.lastValidBlockHeight), validatedSlot: integer(object(latest.context).slot) };
    this.#lifetimes.set(lifetime.blockhash, Object.freeze(lifetime));
    if (this.#lifetimes.size > 256) this.#lifetimes.delete(this.#lifetimes.keys().next().value!);
    return { ...lifetime };
  }
  async validateLifetime(decoded: DecodedUnsignedTransaction, persisted?: TransactionLifetime): Promise<TransactionLifetime> {
    for (const instruction of decoded.instructions) {
      if (instruction.programAddress === SYSTEM_PROGRAM_ADDRESS && instruction.data.length >= 4 && new DataView(instruction.data.buffer, instruction.data.byteOffset, 4).getUint32(0, true) === 4) throw new SignerError('E_LIFETIME', 'durable nonce lifetimes are unsupported');
    }
    await this.lifetime();
    const lifetime = persisted?.blockhash === decoded.lifetimeToken
      ? persisted
      : this.#lifetimes.get(decoded.lifetimeToken ?? '');
    if (!lifetime) throw new SignerError('E_LIFETIME', 'transaction must use a lifetime issued by the trusted development profile');
    const valid = object(await this.call('isBlockhashValid', [lifetime.blockhash, { commitment: 'finalized', minContextSlot: lifetime.validatedSlot }]));
    const height = integer(await this.call('getBlockHeight', [{ commitment: 'finalized', minContextSlot: lifetime.validatedSlot }]));
    if (valid.value !== true || height > lifetime.lastValidBlockHeight) throw new SignerError('E_LIFETIME', 'transaction lifetime is not valid on the trusted development profile');
    return lifetime;
  }
  async fee(messageBase64: string, lifetime: TransactionLifetime): Promise<number> {
    const result = object(await this.call('getFeeForMessage', [messageBase64, { commitment: 'finalized', minContextSlot: lifetime.validatedSlot }]));
    if (integer(object(result.context).slot) < lifetime.validatedSlot) throw new SignerError('E_PROFILE', 'fee quote came from stale RPC context');
    return integer(result.value);
  }
  async reconcile(signature: string, lifetime: TransactionLifetime): Promise<ReconciledOutcome> {
    try {
      await this.assertIdentity();
      const statuses = object(await this.call('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]));
      if (!Array.isArray(statuses.value) || statuses.value.length !== 1) return 'unknown';
      const status = statuses.value[0];
      if (status !== null) {
        const confirmed = object(status).confirmationStatus;
        return confirmed === 'confirmed' || confirmed === 'finalized' ? 'confirmed' : 'unknown';
      }
      const statusSlot = integer(object(statuses.context).slot);
      const height = integer(await this.call('getBlockHeight', [{ commitment: 'finalized', minContextSlot: lifetime.validatedSlot }]));
      if (height <= lifetime.lastValidBlockHeight) return 'unknown';
      // A height from a different load-balanced node cannot establish that the
      // history endpoint is post-expiry. Bind it to an actual finalized block.
      const lastSlot = integer(await this.call('getSlot', [{ commitment: 'finalized', minContextSlot: lifetime.validatedSlot }]));
      const firstSlot = integer(await this.call('minimumLedgerSlot'));
      if (firstSlot > lifetime.validatedSlot || lastSlot < lifetime.validatedSlot || statusSlot < lastSlot) return 'unknown';
      let previousBlock: { slot: number; height: number; hash: string } | undefined;
      for (let start = lifetime.validatedSlot; start <= lastSlot; start += 1000) {
        const end = Math.min(start + 999, lastSlot);
        const slots = await this.call('getBlocks', [start, end, { commitment: 'finalized' }]);
        if (!Array.isArray(slots) || slots.length === 0) return 'unknown';
        let previous = start - 1;
        for (const raw of slots) {
          const slot = integer(raw);
          if (slot < start || slot > end || slot <= previous) return 'unknown';
          previous = slot;
          const block = object(await this.call('getBlock', [slot, { commitment: 'finalized', transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: 0 }]));
          if (!Array.isArray(block.signatures) || !block.signatures.every(s => typeof s === 'string')) return 'unknown';
          const blockHeight = integer(block.blockHeight);
          const parentSlot = integer(block.parentSlot);
          if (typeof block.blockhash !== 'string' || !block.blockhash || typeof block.previousBlockhash !== 'string' || !block.previousBlockhash || parentSlot >= slot) return 'unknown';
          // Parent links also detect omitted produced blocks in getBlocks, not
          // merely missing RPC responses. Skipped slots need not have blocks.
          if (previousBlock
            ? parentSlot !== previousBlock.slot || block.previousBlockhash !== previousBlock.hash || blockHeight !== previousBlock.height + 1
            : parentSlot >= lifetime.validatedSlot) return 'unknown';
          previousBlock = { slot, height: blockHeight, hash: block.blockhash };
          if (block.signatures.includes(signature)) return 'confirmed';
        }
      }
      return previousBlock?.slot === lastSlot && previousBlock.height === height && previousBlock.height > lifetime.lastValidBlockHeight
        ? 'expired-proven-absent' : 'unknown';
    } catch { return 'unknown'; }
  }
}
