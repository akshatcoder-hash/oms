import { COMPUTE_BUDGET_PROGRAM_ADDRESS, LAMPORTS_PER_SIGNATURE, SYSTEM_PROGRAM_ADDRESS } from './constants.ts';
import { SignerError } from './errors.ts';
import type { DecodedUnsignedTransaction } from './tx.ts';

export interface PolicyConfig {
  allowlist: { programIds: readonly string[]; accountIds: readonly string[] };
  spend: { perTxLamports: number; cumulativeLamports: number };
  feeCapLamports: number;
}
export interface OutflowAnalysis { outboundLamports: number; baseFeeLamports: number; priorityFeeLamports: number; feeLamports: number; totalLamports: number }
export interface PolicyDecision { digest: string; outflow: OutflowAnalysis }

export function validatePolicyConfig(config: PolicyConfig): void {
  if (!config || Object.keys(config).some(k => !['allowlist', 'spend', 'feeCapLamports'].includes(k))) throw new SignerError('E_BAD_REQUEST', 'unsupported or legacy signer policy option');
  if (!config.allowlist || !Array.isArray(config.allowlist.programIds) || !Array.isArray(config.allowlist.accountIds) || ![...config.allowlist.programIds, ...config.allowlist.accountIds].every(v => typeof v === 'string')) throw new SignerError('E_BAD_REQUEST', 'invalid policy allowlist');
  if (!config.spend || ![config.spend.perTxLamports, config.spend.cumulativeLamports, config.feeCapLamports].every(n => Number.isSafeInteger(n) && n >= 0)) throw new SignerError('E_BAD_REQUEST', 'spend caps must be nonnegative safe integer lamports');
}

export function analyzeOutflow(decoded: DecodedUnsignedTransaction, signerAddress: string, config: PolicyConfig): OutflowAnalysis {
  let outbound = 0n;
  let units: number | undefined;
  let microLamports: bigint | undefined;
  let unknown = false;
  for (const ix of decoded.instructions) {
    const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    if (ix.programAddress === SYSTEM_PROGRAM_ADDRESS) {
      if (ix.data.length < 4) throw new SignerError('E_MALFORMED_TX', 'truncated system instruction');
      const selector = view.getUint32(0, true);
      if (selector !== 0 && selector !== 2) throw new SignerError('E_PROGRAM_NOT_ALLOWED', 'only bounded system transfer and createAccount instructions are supported');
      if (ix.data.length !== (selector === 2 ? 12 : 52) || ix.accountAddresses.length < 2) throw new SignerError('E_MALFORMED_TX', 'malformed system instruction');
      if (ix.accountAddresses[0] === signerAddress) outbound += view.getBigUint64(4, true);
    } else if (ix.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS) {
      if (ix.data[0] === 2 && ix.data.length === 5 && units === undefined) {
        units = view.getUint32(1, true);
        if (units < 1 || units > 1_400_000) throw new SignerError('E_MALFORMED_TX', 'unsupported compute unit limit');
      } else if (ix.data[0] === 3 && ix.data.length === 9 && microLamports === undefined) {
        microLamports = view.getBigUint64(1, true);
      } else throw new SignerError('E_MALFORMED_TX', 'unsupported, duplicate or malformed compute budget instruction');
    } else unknown = true;
  }
  if (outbound > 0n && unknown) throw new SignerError('E_PROGRAM_NOT_ALLOWED', 'cannot bound mixed custom-program and system outflow');
  // Nonzero priority pricing requires an explicit CU limit; no guessed chain defaults.
  if ((microLamports ?? 0n) > 0n && units === undefined) throw new SignerError('E_MALFORMED_TX', 'priority pricing requires an explicit compute unit limit');
  const baseFee = BigInt(LAMPORTS_PER_SIGNATURE) * BigInt(decoded.numSignerAccounts);
  const priorityFee = (BigInt(units ?? 0) * (microLamports ?? 0n) + 999_999n) / 1_000_000n;
  const fee = baseFee + priorityFee;
  const total = outbound + fee;
  if (fee > BigInt(config.feeCapLamports)) throw new SignerError('E_SPEND_PER_TX', 'full transaction fee exceeds the fee ceiling');
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total > BigInt(config.spend.perTxLamports)) throw new SignerError('E_SPEND_PER_TX', 'full transaction outflow exceeds the per-transaction cap');
  return { outboundLamports: Number(outbound), baseFeeLamports: Number(baseFee), priorityFeeLamports: Number(priorityFee), feeLamports: Number(fee), totalLamports: Number(total) };
}

export function evaluatePolicy(input: { decoded: DecodedUnsignedTransaction; signerAddress: string; config: PolicyConfig }): PolicyDecision {
  const { decoded, signerAddress, config } = input;
  if (decoded.feePayer !== signerAddress) throw new SignerError('E_ACCOUNT_NOT_ALLOWED', 'fee payer is not the issued signer');
  if (decoded.numSignerAccounts !== 1) throw new SignerError('E_MULTISIG_UNSUPPORTED', 'only single-signer messages are supported');
  const programs = new Set(config.allowlist.programIds);
  for (const ix of decoded.instructions) if (!programs.has(ix.programAddress)) throw new SignerError('E_PROGRAM_NOT_ALLOWED', 'program is not allowlisted');
  const accounts = new Set(config.allowlist.accountIds);
  for (const account of decoded.accountKeys) if (account !== signerAddress && !programs.has(account) && !accounts.has(account)) throw new SignerError('E_ACCOUNT_NOT_ALLOWED', 'account is not allowlisted');
  return { digest: decoded.digest, outflow: analyzeOutflow(decoded, signerAddress, config) };
}
