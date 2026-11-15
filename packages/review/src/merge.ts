import { createHash } from 'node:crypto';
import { Value } from 'typebox/value';
import {
  StaticHitSchema,
  SeveritySchema,
  parseModelFindings,
  validLocation,
  type Finding,
  type StaticHit,
  type ModelFinding,
  type Severity,
  type VulnClass,
} from './types.ts';

const severities: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const strongest = (a: Severity, b: Severity): Severity => (severities.indexOf(a) < severities.indexOf(b) ? a : b);
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Phase A only. Callers supply host rule severities, never model confidence.
 * Groups use their first (lowest) line as anchor, preventing transitive chains
 * from collapsing distinct findings. Inputs must come from the filtered snapshot. */
export function mergeFindings(
  staticInputs: readonly unknown[],
  modelInputs: readonly unknown[],
  files: ReadonlyMap<string, number>,
  modelSeverities: Readonly<Partial<Record<VulnClass, Severity>>>,
): { findings: Finding[]; invalidStaticHits: number; invalidModelOutputs: number } {
  let invalidStaticHits = 0;
  const hits: StaticHit[] = [];
  for (const input of staticInputs) {
    if (!Value.Check(StaticHitSchema, input) || !validLocation(input.location, files)) invalidStaticHits++;
    else hits.push(structuredClone(input));
  }
  const parsed = parseModelFindings(modelInputs, files);
  const models: ModelFinding[] = [];
  let invalidModelOutputs = parsed.invalidModelOutputs;
  for (const input of parsed.findings) {
    if (input.location.handler !== undefined && input.location.handler !== input.handler) {
      invalidModelOutputs++;
      continue;
    }
    models.push(structuredClone(input));
  }
  const entries = [
    ...hits.map((hit) => ({
      class: hit.class,
      location: hit.location,
      hit,
      model: undefined as ModelFinding | undefined,
    })),
    ...models.map((model) => ({
      class: model.class,
      location: { ...model.location, handler: model.handler },
      model,
      hit: undefined as StaticHit | undefined,
    })),
  ];
  const key = (entry: (typeof entries)[number]) =>
    JSON.stringify([entry.class, entry.location.file, entry.location.handler ?? '']);
  entries.sort(
    (a, b) =>
      compare(key(a), key(b)) ||
      a.location.line - b.location.line ||
      Number(!!a.model) - Number(!!b.model) ||
      compare(JSON.stringify(a), JSON.stringify(b)),
  );
  const findings: Finding[] = [];
  let previousKey: string | undefined;
  let current: Finding | undefined;
  for (const entry of entries) {
    const groupKey = key(entry);
    const severity = entry.hit?.severity ?? modelSeverities[entry.class];
    if (!Value.Check(SeveritySchema, severity)) throw new Error('Missing or invalid trusted rule severity');
    if (!current || previousKey !== groupKey || entry.location.line - current.location.line > 5) {
      current = {
        id: createHash('sha256')
          .update(JSON.stringify([groupKey, entry.location.line]))
          .digest('hex'),
        label: 'suspected',
        class: entry.class,
        severity,
        title: entry.model?.title ?? entry.hit!.ruleId,
        location: { ...entry.location },
        sources: [],
        explanation: entry.model?.explanation ?? entry.hit!.message,
        fix: entry.model?.fix ?? '',
        staticHits: [],
      };
      findings.push(current);
      previousKey = groupKey;
    }
    current.severity = strongest(current.severity, severity);
    if (entry.hit) {
      if (!current.sources.includes('static')) current.sources.push('static');
      if (!current.staticHits.some((hit) => JSON.stringify(hit) === JSON.stringify(entry.hit)))
        current.staticHits.push(entry.hit);
    }
    if (entry.model && !current.sources.includes('model')) {
      current.title = entry.model.title;
      current.explanation = entry.model.explanation;
      current.fix = entry.model.fix;
      current.sources.push('model');
    }
    current.sources.sort((a, b) => Number(a === 'model') - Number(b === 'model'));
  }
  return { findings, invalidStaticHits, invalidModelOutputs };
}
