/**
 * Test helpers.
 *
 * Two independent obligations live here:
 *  1. building unsigned fixture transactions with @solana/kit,
 *  2. computing secret byte-encodings *without* using src/secret.ts, so the
 *     leak test cannot pass because the detector and the scrubber share a bug.
 */

import { randomBytes, createPrivateKey, createPublicKey } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase58Codec,
  getBase64Codec,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from '@solana/kit';
import type { PolicyConfig } from '../src/policy.ts';
import { startSignerServer } from '../src/server.ts';
import type { ServiceOptions } from '../src/service.ts';
import { generateSignerKeypair } from '../src/init.ts';
import { DEVNET_GENESIS_HASH } from '../src/profile.ts';
import { controlledRpc } from './rpc.ts';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const ZERO_BLOCKHASH = '11111111111111111111111111111111';

const base58 = getBase58Codec();
const base64 = getBase64Codec();

export function toBase58(bytes: Uint8Array): string {
  return base58.decode(bytes);
}

export function toBase64(bytes: Uint8Array): string {
  return base64.decode(bytes);
}

export function hexOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** All the encodings a leaked key could plausibly take in text output. */
export function secretTextForms(bytes: Uint8Array): string[] {
  const hex = hexOf(bytes);
  const b64 = toBase64(bytes);
  const nums = Array.from(bytes);
  return [
    hex,
    hex.toUpperCase(),
    toBase58(bytes),
    b64,
    b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    nums.join(','),
    nums.join(', '),
    '[' + nums.join(',') + ']',
    '[' + nums.join(', ') + ']',
    JSON.stringify(nums),
    JSON.stringify(nums, null, 2),
  ];
}

/** Returns the first leak found in `text`, or null. */
export function findLeak(text: string, forms: readonly string[]): string | null {
  for (const form of forms) {
    if (form.length >= 8 && text.includes(form)) return form.slice(0, 12) + '...';
  }
  return null;
}

export function findLeakInBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  const n = needle;
  outer: for (let i = 0; i + n.length <= haystack.length; i += 1) {
    for (let j = 0; j < n.length; j += 1) {
      if (haystack[i + j] !== n[j]) continue outer;
    }
    return true;
  }
  return false;
}

export function randomAddress(): string {
  return toBase58(randomBytes(32));
}

export interface FixtureKeypair {
  /** 32-byte seed. */
  seed: Uint8Array;
  /** 64-byte solana keypair file layout: seed || publicKey. */
  keypairBytes: Uint8Array;
  address: string;
  path: string;
}

/** Generate a throwaway keypair file in `dir`. Never touches ~/.config/solana. */
export function writeFixtureKeypair(dir: string, name = 'keypair.json'): FixtureKeypair {
  const seed = randomBytes(32);
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const privateKeyObject = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(privateKeyObject).export({ format: 'der', type: 'spki' });
  const publicKey = Uint8Array.from(spki.subarray(spki.length - 32));
  const keypairBytes = Uint8Array.from(Buffer.concat([seed, publicKey]));
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(Array.from(keypairBytes)), { mode: 0o600 });
  chmodSync(path, 0o600);
  return {
    seed: Uint8Array.from(seed),
    keypairBytes,
    address: toBase58(publicKey),
    path,
  };
}

const createdTempDirs: string[] = [];
process.on('exit', () => {
  for (const dir of createdTempDirs) rmSync(dir, { recursive: true, force: true });
});

export function makeTempDir(prefix = 'oms-signer-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdTempDirs.push(dir);
  return dir;
}

/** Read back a keypair file that startTestSigner wrote, as raw bytes. */
export function readFixtureKeypair(path: string): { seed: Uint8Array; keypairBytes: Uint8Array; address: string } {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as number[];
  if (parsed.length !== 64) throw new Error(`unexpected keypair length ${parsed.length}`);
  const keypairBytes = Uint8Array.from(parsed);
  return {
    seed: keypairBytes.subarray(0, 32),
    keypairBytes,
    address: toBase58(keypairBytes.subarray(32)),
  };
}

export interface UnsignedTxOptions {
  feePayer: string;
  instructions: {
    programAddress: string;
    accounts: { address: string; role?: number }[];
    data: Uint8Array;
  }[];
  blockhash?: string;
  version?: 'legacy' | 0;
}

export function buildUnsignedTransaction(options: UnsignedTxOptions): string {
  const instructions = options.instructions.map((instruction) => ({
    programAddress: instruction.programAddress as Address,
    accounts: instruction.accounts.map((account) => ({
      address: account.address as Address,
      role: (account.role ?? AccountRole.WRITABLE) as never,
    })),
    data: instruction.data,
  }));

  const message = pipe(
    createTransactionMessage({ version: options.version ?? 'legacy' }),
    (m) => setTransactionMessageFeePayer(options.feePayer as Address, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: (options.blockhash ?? ZERO_BLOCKHASH) as never, lastValidBlockHeight: 1000n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );

  const compiled = compileTransaction(message);
  return toBase64(Uint8Array.from(getTransactionEncoder().encode(compiled)));
}

export function transferInstructionData(lamports: number | bigint): Uint8Array {
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true);
  new DataView(data.buffer).setBigUint64(4, BigInt(lamports), true);
  return data;
}

export function createAccountInstructionData(lamports: number | bigint): Uint8Array {
  const data = new Uint8Array(52);
  new DataView(data.buffer).setUint32(0, 0, true);
  new DataView(data.buffer).setBigUint64(4, BigInt(lamports), true);
  new DataView(data.buffer).setBigUint64(12, 0n, true);
  return data;
}

export function computeUnitLimitData(units: number): Uint8Array {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return data;
}

export function computeUnitPriceData(microLamports: number | bigint): Uint8Array {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, BigInt(microLamports), true);
  return data;
}

export interface TransferTxInput {
  from: string;
  to: string;
  lamports: number;
  extraInstructions?: UnsignedTxOptions['instructions'];
  blockhash?: string;
}

export function buildTransferTx(input: TransferTxInput): string {
  return buildUnsignedTransaction({
    feePayer: input.from,
    blockhash: input.blockhash,
    instructions: [
      {
        programAddress: SYSTEM_PROGRAM,
        accounts: [
          { address: input.from, role: AccountRole.WRITABLE_SIGNER },
          { address: input.to, role: AccountRole.WRITABLE },
        ],
        data: transferInstructionData(input.lamports),
      },
      ...(input.extraInstructions ?? []),
    ],
  });
}

export function createConfig(overrides: Partial<PolicyConfig> & { accountIds: string[] }): PolicyConfig {
  const { accountIds, ...policyOverrides } = overrides;
  return {
    allowlist: { programIds: [SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM], accountIds },
    spend: { perTxLamports: 1_000_000, cumulativeLamports: 5_000_000 },
    feeCapLamports: 100_000,
    ...policyOverrides,
  };
}

export interface Client {
  readonly lines: string[];
  readonly responses: Record<string, unknown>[];
  send(message: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Writes a raw line without waiting for a response. */
  writeRaw(line: string): void;
  /** Waits for the next response (used after writeRaw). */
  next(timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): Promise<void>;
  readonly socket: Socket;
}

export async function connectClient(socketPath: string, token: string | null): Promise<Client> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });

  const lines: string[] = [];
  const responses: Record<string, unknown>[] = [];
  const queue: Record<string, unknown>[] = [];
  const waiters: ((value: Record<string, unknown>) => void)[] = [];
  let buffer = '';
  let socketClosed = false;

  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length > 0) {
        lines.push(line);
        const parsed = JSON.parse(line) as Record<string, unknown>;
        responses.push(parsed);
        const waiter = waiters.shift();
        if (waiter) waiter(parsed);
        else queue.push(parsed);
      }
      index = buffer.indexOf('\n');
    }
  });
  socket.on('close', () => {
    socketClosed = true;
    for (const waiter of waiters.splice(0)) {
      waiter({ status: 'error', code: 'E_SOCKET_CLOSED', message: 'socket closed' });
    }
  });

  const next = (timeoutMs = 3000): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const queued = queue.shift();
      if (queued) {
        resolve(queued);
        return;
      }
      if (socketClosed) {
        resolve({ status: 'error', code: 'E_SOCKET_CLOSED', message: 'socket closed' });
        return;
      }
      const timer = setTimeout(() => reject(new Error('timeout waiting for signer response')), timeoutMs);
      waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });

  const send = async (message: Record<string, unknown>): Promise<Record<string, unknown>> => {
    socket.write(JSON.stringify(message) + '\n');
    return next();
  };

  if (token !== null) {
    await send({ type: 'hello', token });
  }

  return {
    lines,
    responses,
    send,
    writeRaw(line: string): void {
      socket.write(line + '\n');
    },
    next,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        if (socketClosed) {
          resolve();
          return;
        }
        socket.once('close', () => resolve());
        socket.end();
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 200);
      });
    },
    socket,
  };
}

/** Write a file with an explicit mode, bypassing umask surprises. */
export function writeFileWithMode(path: string, contents: string, mode: number): void {
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
}

export interface TestSignerOptions {
  destinations?: string[];
  configOverrides?: Partial<PolicyConfig>;
  testHooks?: ServiceOptions['testHooks'];
}

export async function startTestSigner(options: TestSignerOptions = {}) {
  const rpc = await controlledRpc();
  const dir = makeTempDir();
  const signerDir = join(dir, 'keys');
  const socketDir = join(dir, 'socket');
  const profile = {
    kind: 'devnet' as const,
    endpoint: rpc.endpoint,
    genesisHash: DEVNET_GENESIS_HASH,
    authorization: 'user-approved' as const,
  };
  const generated = generateSignerKeypair({ signerDir, alias: 'dev', profile });
  const path = join(signerDir, 'dev.key.json');
  const fixture = { ...readFixtureKeypair(path), path };
  const config = createConfig({ accountIds: options.destinations ?? [], ...options.configOverrides });
  const serverOptions = {
    config,
    signerDir,
    alias: 'dev',
    socketDir,
    ...(options.testHooks ? { testHooks: options.testHooks } : {}),
  };
  const running = await startSignerServer(serverOptions);
  return {
    running,
    fixture,
    config,
    dir,
    signerDir,
    socketDir,
    profile,
    generated,
    rpc,
    serverOptions,
    async close() {
      await running.close();
      await rpc.close();
    },
  };
}
