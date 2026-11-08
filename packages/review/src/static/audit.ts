import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { validLocation, type StaticHit } from '../types.ts';
import { redactReviewText } from '../snapshot.ts';

export const AUDIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const Envelope = Type.Object({
  database: Type.Object({}, { additionalProperties: true }),
  lockfile: Type.Object({}, { additionalProperties: true }),
  settings: Type.Object({
    target_arch: Type.Array(Type.String(), { maxItems: 0 }),
    target_os: Type.Array(Type.String(), { maxItems: 0 }),
    severity: Type.Null(), ignore: Type.Array(Type.String(), { maxItems: 0 }),
    informational_warnings: Type.Array(Type.String()),
  }, { additionalProperties: false }),
  vulnerabilities: Type.Object({
    found: Type.Boolean(), count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    list: Type.Array(Type.Unknown(), { maxItems: 10_000 }),
  }, { additionalProperties: false }),
  warnings: Type.Record(Type.String(), Type.Array(Type.Unknown(), { maxItems: 10_000 })),
}, { additionalProperties: false });
const Entry = Type.Object({
  advisory: Type.Object({
    id: Type.String({ pattern: '^RUSTSEC-[0-9]{4}-[0-9]{4}$' }),
    package: Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' }),
    title: Type.String({ minLength: 1, maxLength: 4096 }),
    informational: Type.Null(), withdrawn: Type.Null(),
  }, { additionalProperties: true }),
  package: Type.Object({
    name: Type.String(), version: Type.String({ minLength: 1, maxLength: 128 }),
  }, { additionalProperties: true }),
}, { additionalProperties: true });

export interface AuditResult {
  status: 'ok' | 'failed';
  reason?: string;
  hits: StaticHit[];
  invalidOutputs: number;
}

/** Parse pinned cargo-audit JSON, never raw stderr. Exit 1 is the normal
 * vulnerable result, but only with a consistent nonempty vulnerability list.
 * Locations describe the scanned lockfile, not dependency source reachability.
 * This rule assigns high priority to vulnerability advisories; it does not
 * infer CVSS severity, exploitability, or a clear coverage verdict. */
export function parseAuditResult(
  execution: { exitCode: number | null; stdout: string; timedOut: boolean; truncated: boolean },
  file: string,
  inventory: ReadonlyMap<string, number>,
): AuditResult {
  const failed = (reason: string): AuditResult => ({ status: 'failed', reason, hits: [], invalidOutputs: 0 });
  if (!validLocation({ file, line: 1 }, inventory)) return failed('Audit input is outside the snapshot');
  if (execution.timedOut) return failed('Audit timed out');
  if (execution.exitCode !== 0 && execution.exitCode !== 1) return failed('Audit did not exit successfully');
  if (execution.truncated || Buffer.byteLength(execution.stdout) > AUDIT_OUTPUT_BYTES) return failed('Audit output exceeded the limit');
  let value: unknown;
  try { value = JSON.parse(execution.stdout); }
  catch { return failed('Audit output is not JSON'); }
  if (!Value.Check(Envelope, value)) return failed('Audit output has an invalid envelope');
  const vulnerabilities = value.vulnerabilities;
  if (vulnerabilities.count !== vulnerabilities.list.length ||
      vulnerabilities.found !== (vulnerabilities.count > 0) ||
      execution.exitCode !== (vulnerabilities.found ? 1 : 0)) return failed('Audit outcome is inconsistent');
  const hits: StaticHit[] = [];
  let invalidOutputs = 0;
  for (const entry of vulnerabilities.list) {
    if (!Value.Check(Entry, entry) || entry.advisory.package !== entry.package.name ||
        Buffer.byteLength(entry.advisory.title) > 4096 ||
        !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(entry.package.version)) {
      invalidOutputs++;
      continue;
    }
    const message = redactReviewText(`${entry.advisory.package} ${entry.package.version}: ${entry.advisory.title}`);
    if (Buffer.byteLength(message) > 4096) { invalidOutputs++; continue; }
    hits.push({ tool: 'cargo-audit', ruleId: entry.advisory.id, class: 'dependency-advisory',
      severity: 'high', location: { file, line: 1 }, message });
  }
  // Unmaintained/unsound warnings are not vulnerabilities: report, do not fail.
  const warnings = Object.values(value.warnings).reduce((n, entries) => n + entries.length, 0);
  return { status: invalidOutputs ? 'failed' : 'ok', hits, invalidOutputs,
    ...(invalidOutputs ? { reason: 'Audit returned invalid entries' } :
      warnings ? { reason: `Audit reported ${warnings} unmaintained or unsound dependency warning(s)` } : {}),
  };
}
