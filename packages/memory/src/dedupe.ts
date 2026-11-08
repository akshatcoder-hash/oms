import { jaccard, shingles } from './score.ts';
import { parseLesson, type Lesson } from './types.ts';
import { isDeepStrictEqual } from 'node:util';

/** Merge host-captured local lessons. A replayed verifier run is not a confirmation. */
export function dedupe(rows: readonly Lesson[], candidate: Lesson): Lesson[] {
  parseLesson(candidate);
  if (candidate.tier !== 'quarantined' || candidate.provenance.some(source => source.source !== 'local')) {
    throw new Error('Local capture requires quarantined local provenance');
  }
  const index = rows.findIndex(row => row.tier === 'quarantined'
    && row.provenance.every(source => source.source === 'local')
    && row.signature.key === candidate.signature.key
    && (row.id === candidate.id || isDeepStrictEqual(row.applicability, candidate.applicability))
    && (row.fixKey === candidate.fixKey || jaccard(shingles(row.body.fixPattern), shingles(candidate.body.fixPattern)) >= 0.8));
  if (index < 0) {
    if (rows.some(row => row.id === candidate.id)) throw new Error('Lesson id collision');
    return [...rows, candidate];
  }
  const prior = rows[index]!;
  const tags = new Set(prior.evidence.map(evidence => evidence.evidenceTag));
  const fresh = candidate.evidence.filter(evidence => {
    if (tags.has(evidence.evidenceTag)) return false;
    tags.add(evidence.evidenceTag);
    return true;
  });
  if (!fresh.length) return [...rows];
  const applicabilityChanged = !isDeepStrictEqual(prior.applicability, candidate.applicability);
  const merged = parseLesson({
    ...prior,
    // A fresh confirmation in a different environment creates the next local
    // version. Keep its exact pins rather than inventing an untested range.
    applicability: applicabilityChanged ? candidate.applicability : prior.applicability,
    version: prior.version + Number(applicabilityChanged),
    evidence: [...prior.evidence, ...fresh],
    confirmations: { ...prior.confirmations, closed: prior.confirmations.closed + fresh.length },
    updatedAt: [prior.updatedAt, ...fresh.map(evidence => evidence.at)].sort().at(-1)!,
  });
  return rows.map((row, offset) => offset === index ? merged : row);
}
