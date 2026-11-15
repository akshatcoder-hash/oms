/** Tests the Solana Bench report uses: an exact sign test for paired runs and a permutation test on means for independent groups. */

export interface SignTest { aOnly: number; bOnly: number; both: number; neither: number; pValue: number }

/** Exact two-sided sign test on paired results; only discordant pairs carry information. */
export function signTest(a: readonly boolean[], b: readonly boolean[]): SignTest {
  if (a.length !== b.length) throw new Error('Paired results must have equal length');
  let aOnly = 0; let bOnly = 0; let both = 0; let neither = 0;
  a.forEach((value, index) => {
    if (value && b[index]) both++; else if (value) aOnly++; else if (b[index]) bOnly++; else neither++;
  });
  const discordant = aOnly + bOnly;
  if (discordant === 0) return { aOnly, bOnly, both, neither, pValue: 1 };
  if (discordant > 1000) throw new Error('Too many discordant pairs for the exact test');
  const k = Math.min(aOnly, bOnly);
  let pmf = Math.pow(0.5, discordant);
  let tail = pmf;
  for (let i = 1; i <= k; i++) { pmf = (pmf * (discordant - i + 1)) / i; tail += pmf; }
  return { aOnly, bOnly, both, neither, pValue: Math.min(1, 2 * tail) };
}

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Small seeded generator (mulberry32), so a sampled p-value is reproducible. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Two-sided permutation test on the difference of means between two independent groups of run scores: p is the share of
 * splits of the pooled scores into groups of the observed sizes whose absolute difference of means is at least the observed
 * one. Every split is enumerated when there are at most `exactLimit` of them; otherwise `samples` random splits are drawn
 * from a fixed seed, so the same scores always give the same p (sampled p-values move in the third decimal with the seed).
 * This is the test behind the published OMS Solana Bench p-values.
 */
export function meanPermutation(a: readonly number[], b: readonly number[], options: { samples?: number; seed?: number; exactLimit?: number } = {}):
  { observed: number; pValue: number; splits: number; exact: boolean } {
  if (!a.length || !b.length) throw new Error('Both groups need at least one run');
  const { samples = 200_000, seed = 20_261_114, exactLimit = 2_000_000 } = options;
  const pooled = [...a, ...b];
  const total = pooled.length;
  const sum = pooled.reduce((acc, value) => acc + value, 0);
  const observed = mean(a) - mean(b);
  const extremeFor = (leftSum: number): boolean =>
    Math.abs(leftSum / a.length - (sum - leftSum) / b.length) >= Math.abs(observed) - 1e-9;
  let splits = 1;
  for (let i = 1; i <= a.length; i++) splits = splits * (total - a.length + i) / i;
  if (splits <= exactLimit) {
    let extreme = 0;
    let count = 0;
    const visit = (start: number, chosen: number, leftSum: number): void => {
      if (chosen === a.length) { count++; if (extremeFor(leftSum)) extreme++; return; }
      for (let i = start; i <= total - (a.length - chosen); i++) visit(i + 1, chosen + 1, leftSum + pooled[i]!);
    };
    visit(0, 0, 0);
    return { observed, pValue: extreme / count, splits: count, exact: true };
  }
  const random = seeded(seed);
  const work = [...pooled];
  let extreme = 0;
  for (let n = 0; n < samples; n++) {
    let leftSum = 0;
    for (let i = 0; i < a.length; i++) {
      const j = i + Math.floor(random() * (total - i));
      [work[i], work[j]] = [work[j]!, work[i]!];
      leftSum += work[i]!;
    }
    if (extremeFor(leftSum)) extreme++;
  }
  return { observed, pValue: extreme / samples, splits: samples, exact: false };
}
