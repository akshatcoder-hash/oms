/** Exact tests the Solana Bench report uses. No Monte Carlo: every statistic below enumerates its whole null distribution. */

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

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/**
 * Exact two-sided permutation test on the difference of medians between two independent groups of run scores: every way of
 * splitting the pooled scores into groups of the observed sizes is enumerated, and p is the share whose absolute difference of
 * medians is at least the observed one (ties count as extreme). Medians tie often, so with 5 vs 5 even fully separated groups give p above 2/252.
 */
export function medianPermutation(a: readonly number[], b: readonly number[]): { observed: number; pValue: number; splits: number } {
  if (!a.length || !b.length) throw new Error('Both groups need at least one run');
  const pooled = [...a, ...b];
  const total = pooled.length;
  let splits = 1;
  for (let i = 1; i <= a.length; i++) splits = splits * (total - a.length + i) / i;
  if (splits > 2_000_000) throw new Error('Too many splits for the exact test');
  const observed = median(a) - median(b);
  let extreme = 0;
  let count = 0;
  const pick: number[] = [];
  const visit = (start: number): void => {
    if (pick.length === a.length) {
      const chosen = new Set(pick);
      const left = pick.map(i => pooled[i]!);
      const right = pooled.filter((_, i) => !chosen.has(i));
      count++;
      if (Math.abs(median(left) - median(right)) >= Math.abs(observed) - 1e-9) extreme++;
      return;
    }
    for (let i = start; i < total; i++) { pick.push(i); visit(i + 1); pick.pop(); }
  };
  visit(0);
  return { observed, pValue: extreme / count, splits: count };
}
