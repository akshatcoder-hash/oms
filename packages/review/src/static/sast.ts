import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { StaticHitSchema, VULN_CLASSES, validLocation, type StaticHit } from '../types.ts';
import { redactReviewText } from '../snapshot.ts';

const EnvelopeSchema = Type.Object(
  {
    hits: Type.Array(Type.Unknown(), { maxItems: 10_000 }),
    // Emitted by the scanner; handler inventory comes from discovery instead.
    handlers: Type.Array(Type.Unknown(), { maxItems: 10_000 }),
    implementedRules: Type.Array(
      Type.String({
        maxLength: 128,
        pattern: `^(${VULN_CLASSES.join('|')})/[a-z][a-z0-9-]{0,62}$`,
      }),
      { maxItems: 256, uniqueItems: true },
    ),
  },
  { additionalProperties: false },
);

export interface SastResult {
  status: 'ok' | 'failed';
  reason?: string;
  hits: StaticHit[];
  implementedRules: string[];
  invalidOutputs: number;
}

export const SAST_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Consume one scanner invocation against one immutable snapshot file. The
 * execution port must also cap output while collecting it and enforce timeout.
 * Never expose raw diagnostics: user-controlled source may appear in errors.
 * An absent hit cannot establish that a class is clear. */
export function parseSastResult(
  execution: { exitCode: number | null; stdout: string; timedOut: boolean; truncated: boolean },
  file: string,
  inventory: ReadonlyMap<string, number>,
): SastResult {
  const failed = (reason: string): SastResult => ({
    status: 'failed',
    reason,
    hits: [],
    implementedRules: [],
    invalidOutputs: 0,
  });
  if (!validLocation({ file, line: 1 }, inventory)) return failed('Scanner input is outside the snapshot');
  if (execution.timedOut) return failed('Scanner timed out');
  if (execution.exitCode !== 0) return failed('Scanner did not exit successfully');
  if (execution.truncated || Buffer.byteLength(execution.stdout) > SAST_OUTPUT_BYTES)
    return failed('Scanner output exceeded the limit');
  let value: unknown;
  try {
    value = JSON.parse(execution.stdout);
  } catch {
    return failed('Scanner output is not JSON');
  }
  if (!Value.Check(EnvelopeSchema, value)) return failed('Scanner output has an invalid envelope');
  const rules = new Set(value.implementedRules);
  const hits: StaticHit[] = [];
  let invalidOutputs = 0;
  for (const hit of value.hits) {
    if (
      !Value.Check(StaticHitSchema, hit) ||
      hit.tool !== 'oms-sast' ||
      [hit.message, hit.location.file, hit.location.handler ?? ''].some((text) => Buffer.byteLength(text) > 4096) ||
      !rules.has(hit.ruleId) ||
      !hit.ruleId.startsWith(hit.class + '/') ||
      hit.location.file !== file ||
      !validLocation(hit.location, inventory)
    ) {
      invalidOutputs++;
      continue;
    }
    hits.push({
      ...hit,
      message: redactReviewText(hit.message),
      location: {
        ...hit.location,
        ...(hit.location.handler === undefined ? {} : { handler: redactReviewText(hit.location.handler) }),
      },
    });
  }
  return {
    status: invalidOutputs ? 'failed' : 'ok',
    ...(invalidOutputs ? { reason: 'Scanner returned invalid entries' } : {}),
    hits,
    implementedRules: value.implementedRules,
    invalidOutputs,
  };
}
