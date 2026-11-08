import type { ErrorSignature } from './normalize.ts';
export type LessonTier = 'quarantined' | 'corroborated' | 'verified' | 'retired';
export function shingles(text: string): Set<string> {
  const words = text.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length < 3) return new Set(words.length ? [words.join(' ')] : []);
  return new Set(words.slice(0, -2).map((_, i) => words.slice(i, i + 3).join(' ')));
}
export function jaccard(a: Set<string>, b: Set<string>): number {
  const union = new Set([...a, ...b]);
  return union.size ? [...a].filter(value => b.has(value)).length / union.size : 0;
}
export function confidence(a: ErrorSignature, b: ErrorSignature, tier: LessonTier): number {
  const weight = { verified: 1, corroborated: 0.6, quarantined: 0.4, retired: 0 }[tier];
  return (a.key === b.key ? 1 : jaccard(shingles(a.normalized), shingles(b.normalized))) * weight;
}
