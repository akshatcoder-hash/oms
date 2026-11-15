import type { ReviewSnapshot } from '../snapshot.ts';
import { validLocation, type StaticHit } from '../types.ts';
import { parseSastResult, SAST_OUTPUT_BYTES } from './sast.ts';
import { parseAuditResult, AUDIT_OUTPUT_BYTES } from './audit.ts';

/** Trusted discovery supplies the workspace manifest/lockfile relationship.
 * Never infer dependency versions from an unrelated nested Cargo.lock. */
export interface StaticScope {
  sources: readonly string[];
  manifest?: string;
  lockfile?: string;
}
export interface StaticRequest {
  tool: 'oms-sast' | 'cargo-audit';
  argv: readonly string[];
  /** Only these captured, filtered files may be materialized under /work. */
  files: ReadonlyMap<string, string>;
  cwd: '/work';
  network: 'none';
  readOnly: true;
  timeoutMs: number;
  outputBytes: number;
}
/** The trusted engine adapter must enforce timeout/output bounds during
 * collection, use the pinned review image and DEFAULT_LIMITS, cap writable
 * scratch, and mount captured inputs read-only. No host environment inheritance,
 * workspace mount, shell, Cargo build, model call or network fallback. */
export interface StaticExecutionPort {
  run(request: StaticRequest): Promise<{
    exitCode: number | null; stdout: string; timedOut: boolean; truncated: boolean;
  }>;
}
export interface StaticScan {
  tool: StaticRequest['tool'];
  file: string;
  status: 'ok' | 'failed' | 'skipped';
  reason?: string;
  implementedRules: string[];
}
export interface StaticPass {
  scans: StaticScan[];
  hits: StaticHit[];
  invalidOutputs: number;
}

export interface StaticPassBudget {
  /** Whole-pass admission deadline; container cleanup is still awaited. */
  timeoutMs: number;
  /** Cumulative returned stdout, including invalid outputs. */
  outputBytes: number;
}
const DEFAULT_STATIC_PASS_BUDGET: Readonly<StaticPassBudget> = Object.freeze({
  timeoutMs: 15 * 60 * 1000, outputBytes: 32 * 1024 * 1024,
});

/** One explicit workspace scope, sequential and deterministic. Failures remain
 * visible and never discard valid hits from other files or produce clear rows.
 * Clippy (Phase B) and opt-in X-Ray are not implemented by this pass. */
export async function runStaticPass(
  snapshot: ReviewSnapshot, scope: StaticScope, port: StaticExecutionPort,
  budget: StaticPassBudget = DEFAULT_STATIC_PASS_BUDGET,
  now: () => number = () => performance.now(),
): Promise<StaticPass> {
  const { timeoutMs, outputBytes } = budget;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_STATIC_PASS_BUDGET.timeoutMs ||
      !Number.isSafeInteger(outputBytes) || outputBytes < 1 || outputBytes > DEFAULT_STATIC_PASS_BUDGET.outputBytes) {
    throw new Error('Invalid static analysis budget');
  }
  const started = now();
  let remainingOutput = outputBytes;
  const inventory = snapshot.inventory();
  const sources = [...new Set(scope.sources)].sort();
  const { manifest, lockfile } = scope;
  const paths = [...sources, ...(manifest === undefined ? [] : [manifest]), ...(lockfile === undefined ? [] : [lockfile])];
  if (sources.length > 2000 || paths.some(file => !validLocation({ file, line: 1 }, inventory)) ||
      sources.some(file => !file.endsWith('.rs')) ||
      (manifest !== undefined && manifest.split('/').at(-1) !== 'Cargo.toml') ||
      (lockfile !== undefined && lockfile.split('/').at(-1) !== 'Cargo.lock')) {
    throw new Error('Invalid static analysis scope');
  }
  // Capture every requested byte before the first invocation. No later read can
  // observe edits made to the workspace while a tool is executing.
  const captured = new Map(paths.map(file => [file, snapshot.read(file)]));
  const result: StaticPass = { scans: [], hits: [], invalidOutputs: 0 };
  async function scan(tool: StaticRequest['tool'], file: string, argv: string[], inputs: string[]) {
    const remainingTime = Math.floor(timeoutMs - (now() - started));
    if (!Number.isFinite(remainingTime) || remainingTime <= 0 || remainingOutput <= 0) {
      result.scans.push({ tool, file, status: 'skipped', reason: 'Static pass budget exhausted', implementedRules: [] });
      return;
    }
    const allowance = Math.min(remainingOutput, tool === 'oms-sast' ? SAST_OUTPUT_BYTES : AUDIT_OUTPUT_BYTES);
    // Reserve before dispatch. Exceptions retain their reservation because the
    // amount of output produced before failure is unknown.
    remainingOutput -= allowance;
    try {
      const execution = await port.run({ tool, argv, files: new Map(inputs.map(path => [path, captured.get(path)!])),
        cwd: '/work', network: 'none', readOnly: true, timeoutMs: Math.min(300000, remainingTime),
        outputBytes: allowance });
      const bytes = Buffer.byteLength(execution.stdout);
      remainingOutput += Math.max(0, allowance - bytes);
      if (bytes > allowance) {
        // A nonconforming port must not pass oversized data to the parser or
        // receive further work after breaking the collection contract.
        remainingOutput = 0;
        throw new Error('Static output allowance exceeded');
      }
      const sast = tool === 'oms-sast' ? parseSastResult(execution, file, inventory) : undefined;
      const parsed = sast ?? parseAuditResult(execution, file, inventory);
      const rules = sast?.implementedRules ?? [];
      result.scans.push({ tool, file, status: parsed.status, ...(parsed.reason ? { reason: parsed.reason } : {}), implementedRules: rules });
      result.hits.push(...parsed.hits);
      result.invalidOutputs += parsed.invalidOutputs;
    } catch {
      // Tool exceptions can contain source or environment data. Never persist them.
      result.scans.push({ tool, file, status: 'failed', reason: 'Static tool execution failed', implementedRules: [] });
    }
  }
  for (const file of sources) {
    await scan('oms-sast', file, ['oms-sast', '--file', file, ...(lockfile === undefined ? [] : ['--lockfile', lockfile])],
      [file, ...(lockfile === undefined ? [] : [lockfile])]);
  }
  if (sources.length === 0) result.scans.push({ tool: 'oms-sast', file: '', status: 'skipped', reason: 'No Rust source in scope', implementedRules: [] });
  if (manifest !== undefined) await scan('oms-sast', manifest, ['oms-sast', '--manifest', manifest], [manifest]);
  else result.scans.push({ tool: 'oms-sast', file: '', status: 'skipped', reason: 'No workspace manifest in scope', implementedRules: [] });
  if (lockfile !== undefined) await scan('cargo-audit', lockfile,
    ['cargo-audit', 'audit', '--no-fetch', '--db', '/opt/advisory-db', '--file', `/work/${lockfile}`, '--json'], [lockfile]);
  else result.scans.push({ tool: 'cargo-audit', file: '', status: 'skipped', reason: 'No lockfile in scope; dependency checks unavailable', implementedRules: [] });
  return result;
}
