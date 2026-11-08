import { lstatSync } from 'node:fs';
import type { CaptureFailure } from '../../memory/src/capture.ts';
import { normalize } from '../../memory/src/normalize.ts';
import { scrub } from '../../memory/src/scrub.ts';
import { isMissing, readPrivateJson, writePrivateJson } from './workspace/storage.ts';

export interface MemoryHistory {
  get(itemId: string): CaptureFailure | undefined;
  set(itemId: string, failure: CaptureFailure): void;
  delete(itemId: string): void;
}
interface HistoryFile {
  schema: 'oms.memory-history/1';
  scope: string;
  failures: [string, CaptureFailure][];
}
const digest = /^[a-f0-9]{64}$/;
/** Caller owns the private parent outside the sandbox and holds the task lease.
 * Persist only vocabulary-gated diagnostics, never raw verifier output.
 */
export function createMemoryHistory(options: {
  path: string; scope: string; vocabulary: ReadonlySet<string>; secretForms: readonly string[];
}): MemoryHistory {
  if (!digest.test(options.scope)) throw new Error('Invalid memory history scope');
  const vocabulary = new Set(options.vocabulary);
  const secrets = [...options.secretForms];
  const read = (): Map<string, CaptureFailure> => {
    let value: unknown;
    try {
      if (lstatSync(options.path).size > 500_000) throw new Error('Oversized memory history');
      value = readPrivateJson(options.path);
    } catch (error) { if (isMissing(error)) return new Map(); throw error; }
    const file = value as HistoryFile;
    if (!file || file.schema !== 'oms.memory-history/1' || !digest.test(file.scope) ||
        !Array.isArray(file.failures) || file.failures.length > 100 ||
        Object.keys(file).sort().join(',') !== 'failures,schema,scope') throw new Error('Invalid memory history');
    const rows = new Map<string, CaptureFailure>();
    for (const row of file.failures) {
      if (!Array.isArray(row) || row.length !== 2) throw new Error('Invalid memory history entry');
      const [id, failure] = row;
      if (typeof id !== 'string' || !id.length || id.length > 256 || rows.has(id) ||
          !failure || failure.reason !== 'failed' || typeof failure.failureDigest !== 'string' || !digest.test(failure.failureDigest) ||
          typeof failure.output !== 'string' || failure.output.length > 1024 ||
          !Number.isSafeInteger(failure.reopenCount) || failure.reopenCount < 1 ||
          Object.keys(failure).sort().join(',') !== 'failureDigest,output,reason,reopenCount') throw new Error('Invalid memory history entry');
      rows.set(id, structuredClone(failure));
    }
    return file.scope === options.scope ? rows : new Map();
  };
  const write = (rows: Map<string, CaptureFailure>): void => {
    while (rows.size > 100) rows.delete(rows.keys().next().value!);
    writePrivateJson(options.path, { schema: 'oms.memory-history/1', scope: options.scope, failures: [...rows] });
  };
  return {
    get(itemId) { return read().get(itemId); },
    set(itemId, failure) {
      if (!itemId.length || itemId.length > 256) throw new Error('Invalid memory history item');
      const signature = normalize(failure.output, 'verifier', 'other');
      const publicVocabulary = new Set(vocabulary);
      if (signature.code !== null) {
        if (!/^(?:rustc:E[0-9]{4}|anchor:[0-9]{1,10}|program:0x[0-9a-f]{1,8}|ts:[0-9]{1,10})$/i.test(signature.code)) throw new Error('Unsupported diagnostic code');
        publicVocabulary.add(signature.code.toLowerCase());
      }
      const output = scrub(signature.normalized, publicVocabulary, secrets).text.slice(0, 1024);
      const rows = read();
      rows.delete(itemId);
      rows.set(itemId, { reason: 'failed', failureDigest: failure.failureDigest, reopenCount: failure.reopenCount, output });
      write(rows);
    },
    delete(itemId) { const rows = read(); if (rows.delete(itemId)) write(rows); },
  };
}
