/**
 * Verifier evidence and the result cache.
 *
 * Evidence is the only thing that can close a contract item. It is bound to
 * the immutable requirement/configuration, complete code inputs, pinned verifier,
 * and the actual surfnet snapshot. A run against a mainnet fork is valid
 * evidence of *something*, but it is not reproducible, so it is labeled
 * `forked` and can never close an item.
 */

import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './atomic.ts';
import { assertOutsideRoot } from './paths.ts';
import { failResult, okResult, validationIssue, type Result } from './result.ts';

export type EvidenceMode = 'offline-snapshot' | 'forked';

export interface Evidence {
  itemId: string;
  specificationDigest: string;
  codeDigest: string;
  verifierDigest: string;
  snapshotDigest: string;
  mode: EvidenceMode;
  passed: boolean;
  /** Human-readable reason the run passed or failed. Never trusted as proof. */
  details: string;
  /** ISO 8601 timestamp of the run. */
  at: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Cache key excludes mutable status/reopen fields but binds the requirement.
 * Digests are validated so a caller cannot smuggle separators into the key.
 */
export function evidenceCacheKey(parts: {
  specificationDigest: string;
  codeDigest: string;
  verifierDigest: string;
  snapshotDigest: string;
}): string {
  for (const field of ['specificationDigest', 'codeDigest', 'verifierDigest', 'snapshotDigest'] as const) {
    if (!isDigest(parts[field])) {
      throw new TypeError(`evidenceCacheKey: ${field} must be a sha256 hex digest`);
    }
  }
  return `${parts.specificationDigest}:${parts.codeDigest}:${parts.verifierDigest}:${parts.snapshotDigest}`;
}

const EVIDENCE_KEYS = new Set([
  'itemId',
  'specificationDigest',
  'codeDigest',
  'verifierDigest',
  'snapshotDigest',
  'mode',
  'passed',
  'details',
  'at',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function parseEvidence(input: unknown): Result<Evidence> {
  if (!isPlainObject(input)) {
    return failResult([validationIssue('', 'E_NOT_OBJECT', 'evidence must be an object')]);
  }
  const issues = [];
  for (const key of Object.keys(input)) {
    if (!EVIDENCE_KEYS.has(key)) {
      issues.push(validationIssue(key, 'E_UNKNOWN_FIELD', `unknown evidence field "${key}"`));
    }
  }
  const itemId = input['itemId'];
  if (typeof itemId !== 'string' || itemId.trim().length === 0) {
    issues.push(validationIssue('itemId', 'E_BAD_ITEM_ID', 'itemId must be a non-empty string'));
  }
  for (const field of ['specificationDigest', 'codeDigest', 'verifierDigest', 'snapshotDigest'] as const) {
    if (!isDigest(input[field])) {
      issues.push(validationIssue(field, 'E_BAD_DIGEST', `${field} must be a sha256 hex digest`));
    }
  }
  const mode = input['mode'];
  if (mode !== 'offline-snapshot' && mode !== 'forked') {
    issues.push(validationIssue('mode', 'E_BAD_MODE', 'mode must be "offline-snapshot" or "forked"'));
  }
  if (typeof input['passed'] !== 'boolean') {
    issues.push(validationIssue('passed', 'E_BAD_BOOLEAN', 'passed must be a boolean'));
  }
  if (typeof input['details'] !== 'string') {
    issues.push(validationIssue('details', 'E_BAD_STRING', 'details must be a string'));
  }
  if (!isIsoTimestamp(input['at'])) {
    issues.push(validationIssue('at', 'E_BAD_TIMESTAMP', 'at must be an ISO 8601 UTC timestamp'));
  }
  if (issues.length > 0) return failResult(issues);
  return okResult({
    itemId: itemId as string,
    specificationDigest: input['specificationDigest'] as string,
    codeDigest: input['codeDigest'] as string,
    verifierDigest: input['verifierDigest'] as string,
    snapshotDigest: input['snapshotDigest'] as string,
    mode: mode as EvidenceMode,
    passed: input['passed'] as boolean,
    details: input['details'] as string,
    at: input['at'] as string,
  });
}

export interface VerifierCache {
  readonly kind: 'memory' | 'file';
  get(key: string): Evidence | undefined;
  set(key: string, evidence: Evidence): void;
  has(key: string): boolean;
  size(): number;
}

export interface VerifierCacheOptions {
  /**
   * When set, results are persisted to this JSON file. It must live outside the
   * project root: a cache the generator can write is a way to fake a pass.
   */
  path?: string;
  /** Project root used to enforce the rule above. */
  projectRoot?: string;
}

interface CacheFile {
  schema: 'oms.verifier-cache/0';
  entries: Record<string, Evidence>;
}

const CACHE_SCHEMA = 'oms.verifier-cache/0';

function loadCacheFile(path: string): Map<string, Evidence> {
  const entries = new Map<string, Evidence>();
  if (!existsSync(path)) return entries;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A corrupt cache is only a cache; drop it and re-run the verifier.
    return entries;
  }
  if (!isPlainObject(parsed)) return entries;
  if (parsed['schema'] !== CACHE_SCHEMA) return entries;
  const raw = parsed['entries'];
  if (!isPlainObject(raw)) return entries;
  for (const [key, value] of Object.entries(raw)) {
    const evidence = parseEvidence(value);
    if (evidence.ok) entries.set(key, evidence.value);
  }
  return entries;
}

/**
 * In-memory cache, or a JSON-file-backed one when `path` is given.
 * A file-backed cache is loaded on first use and rewritten atomically per set.
 */
export function createVerifierCache(options: VerifierCacheOptions = {}): VerifierCache {
  if (options.path === undefined) {
    const entries = new Map<string, Evidence>();
    return {
      kind: 'memory',
      get: (key) => entries.get(key),
      set: (key, evidence) => {
        entries.set(key, { ...evidence });
      },
      has: (key) => entries.has(key),
      size: () => entries.size,
    };
  }

  const path = options.path;
  if (options.projectRoot !== undefined) assertOutsideRoot(options.projectRoot, path);

  let entries: Map<string, Evidence> | undefined;
  const load = (): Map<string, Evidence> => {
    if (entries === undefined) entries = loadCacheFile(path);
    return entries;
  };
  const flush = (): void => {
    const payload: CacheFile = { schema: CACHE_SCHEMA, entries: Object.fromEntries(load()) };
    writeFileAtomic(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  };

  return {
    kind: 'file',
    get: (key) => load().get(key),
    set: (key, evidence) => {
      load().set(key, { ...evidence });
      flush();
    },
    has: (key) => load().has(key),
    size: () => load().size,
  };
}
