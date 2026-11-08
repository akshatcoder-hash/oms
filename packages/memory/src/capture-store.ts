import { capture, type CaptureInput } from './capture.ts';
import { dedupe } from './dedupe.ts';
import { memoryPath, updateLessons } from './store.ts';

/**
 * Trusted host entry point; callers supply evaluator observations, not tool arguments.
 * Returns the capture candidate, not the merged store row; read the store for
 * current confirmations, versions and ids after fuzzy deduplication or eviction.
 */
export async function captureAndStore(
  options: { home: string; workspace: string },
  input: CaptureInput,
): Promise<Awaited<ReturnType<typeof capture>>> {
  const candidate = await capture(input);
  if (!candidate) return null;
  // Read and merge under the writer lock, after any asynchronous summarization.
  updateLessons(memoryPath(options.home, options.workspace), options.workspace,
    rows => dedupe(rows, candidate.lesson));
  return candidate;
}
