/**
 * Public surface of `@oms/contract`: task contracts, digest pinning, evidence
 * and evaluation. Host-only Node filesystem operations own source exclusion,
 * checked input capture, trusted state and the file-backed evidence cache.
 */

export * from './atomic.ts';
export * from './contract-io.ts';
export * from './digest.ts';
export * from './evaluator.ts';
export * from './evidence.ts';
export * from './paths.ts';
export * from './inputs.ts';
export * from './pin.ts';
export * from './result.ts';
export * from './schema.ts';
export * from './store.ts';
export * from './types.ts';
export * from './source-access.ts';
