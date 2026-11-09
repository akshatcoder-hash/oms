import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createStaticExecutionPort, reviewToolsImage } from '../../engine/src/runtime/review-ports.ts';
import { ProgramSelectionError, REVIEW_DISCLAIMER, declaresCargoWorkspace, expireReviews, exportReview, isNested, privateDirectory, purgeReviews, runPhaseA, saveReview } from '../../review/src/index.ts';
import { captureSnapshot } from '../../review/src/snapshot.ts';
import type { ProgramSelector } from '../../review/src/pipeline.ts';

const HELP = `oms review [path] --phase A [--program <name>] [--json] [--out <new-directory>] [--state-root <directory>] [--retention-days <n>]
oms review [path] --purge <reviewId|all> [--state-root <directory>]

Phase A reviews a local Cargo package using offline static tools and saves a private report.
Select a package directory containing Cargo.toml, or use --program for a nested package.
A package inside a Cargo workspace is reviewed from the workspace root.
Without --program, a path holding exactly one nested program selects that program.
--program requires one unambiguous discovered Cargo package name and a complete inventory.
Workspace selection preserves workspace-relative citations and checks dependencies against the workspace Cargo.lock.
No model is called. Phase B, model dispatch and replay are not available yet.
--phase A is required for a review until Phase B and automatic phase selection are implemented.
--out writes only report.md and report.json to a new directory; no logs or proof material.
Default state: ~/.oms-review (outside the reviewed workspace). Saved reports expire after 30 days.
--retention-days sets a positive whole number of days for this run's startup cleanup, scoped to this checkout.
`;
export interface ReviewPresentation { reviewId: string; markdown: string; confirmed: number; suspected: number }
interface Output { stdout(text: string): void; stderr(text: string): void; report?(value: ReviewPresentation): void }
class UsageError extends Error {}
const PACKAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,255}$/;
interface Options { repo: string; stateRoot: string; json: boolean; purge?: string; out?: string; program?: string; help: boolean; retentionDays: number }
function parse(args: readonly string[]): Options {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  let path: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) {
      if (path !== undefined) throw new UsageError('Expected one local workspace path');
      path = arg; continue;
    }
    if (flags.has(arg) || values.has(arg)) throw new UsageError('Duplicate review option');
    if (['--json', '--help'].includes(arg)) { flags.add(arg); continue; }
    if (!['--phase', '--purge', '--state-root', '--out', '--retention-days', '--program'].includes(arg)) throw new UsageError('Unsupported review option; see oms review --help');
    const value = args[++i];
    if (!value || value.startsWith('-')) throw new UsageError('Review option requires a value');
    values.set(arg, value);
  }
  const purge = values.get('--purge');
  const help = flags.has('--help');
  const program = values.get('--program');
  if (program !== undefined && !PACKAGE_NAME.test(program)) {
    throw new UsageError('Program must be a Cargo package name');
  }
  const retentionValue = values.get('--retention-days') ?? '30';
  const retentionDays = Number(retentionValue);
  if (!/^[1-9][0-9]*$/.test(retentionValue) || !Number.isSafeInteger(retentionDays) ||
      !Number.isSafeInteger(retentionDays * 86400000) || !Number.isSafeInteger(Date.now() - retentionDays * 86400000)) {
    throw new UsageError('Retention days must be a positive whole number within the supported timestamp range');
  }
  if (help && (args.length !== 1)) throw new UsageError('Use --help by itself');
  if (purge !== undefined && purge !== 'all' && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(purge)) throw new UsageError('Invalid review ID');
  if (values.has('--phase') && values.get('--phase') !== 'A') throw new UsageError('Only Phase A is implemented');
  if (purge !== undefined && (values.has('--phase') || values.has('--out') || values.has('--retention-days') || values.has('--program') || flags.has('--json'))) {
    throw new UsageError('Use purge separately from a review');
  }
  if (!help && purge === undefined && values.get('--phase') !== 'A') {
    throw new UsageError('Specify --phase A; Phase B and automatic phase selection are not implemented');
  }
  const repo = resolve(path ?? '.');
  const stateRoot = resolve(values.get('--state-root') ?? join(homedir(), '.oms-review'));
  const out = values.has('--out') ? resolve(values.get('--out')!) : undefined;
  if (out && isNested(stateRoot, out)) throw new UsageError('Export must be outside private review state');
  if (/[\x00-\x1f\x7f]/.test(repo + stateRoot + (out ?? ''))) throw new UsageError('Control characters are not supported in review paths');
  return { repo, stateRoot,
    json: flags.has('--json'), purge, out, program, help, retentionDays };
}
async function prepareState(stateRoot: string, repo: string): Promise<void> {
  if (isNested(repo, stateRoot) || isNested(join(stateRoot, 'reviews'), repo) ||
      isNested(join(stateRoot, 'review-scratch'), repo)) {
    throw new Error('Review state overlaps workspace');
  }
  // Only create a single directory under an existing canonical parent. This
  // avoids recursive writes through symlinks or inside the reviewed checkout.
  if (await realpath(dirname(stateRoot)) !== dirname(stateRoot)) throw new Error('Symlinked state parent');
  await privateDirectory(stateRoot, true);
}
/** Nearest directory from `repo` up to the git top level whose Cargo.toml
 * declares a workspace; `repo` itself when there is none. */
async function cargoRoot(repo: string, top: string): Promise<string> {
  for (let dir = repo; isNested(top, dir); dir = dirname(dir)) {
    // Never follow a symlinked or oversized manifest outside the captured scope.
    const file = join(dir, 'Cargo.toml');
    const stat = await lstat(file).catch(() => undefined);
    if (stat?.isFile() && stat.size <= 1024 * 1024 && declaresCargoWorkspace(await readFile(file, 'utf8'))) return dir;
    if (dir === top) break;
  }
  return repo;
}
function gitCommand(repo: string, ...args: string[]): string {
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false', '-C', repo, ...args],
  { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
function gitState(repo: string): { commit: string; dirty: boolean; status: string } {
  // Status may invoke clean/process filters while hashing changed files. Refuse
  // configured filters before that read; no project-defined process runs here.
  let filters = '';
  try { filters = gitCommand(repo, 'config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$'); }
  catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
  if (filters.trim()) throw new Error('Git filters are unsupported during review');
  const git = (...args: string[]) => gitCommand(repo, ...args);
  const commit = git('rev-parse', '--verify', 'HEAD').trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('Invalid git identity');
  const status = git('status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all');
  return { commit, dirty: status.length > 0, status };
}

/** Local, keyless Phase A entry point. No inference or chain execution fallback.
 * Errors never echo source text, child diagnostics, environment or user arguments. */
export async function runReviewCommand(args: readonly string[], io: Output = {
  stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); },
}): Promise<number> {
  io.stderr(REVIEW_DISCLAIMER + '\n');
  let selector: ProgramSelector | undefined;
  try {
    const options = parse(args);
    if (options.help) { io.stdout(HELP); return 0; }
    const repo = await realpath(options.repo);
    if (!(await lstat(repo)).isDirectory()) throw new UsageError('Review path must be a local directory');
    const workspace = await realpath(gitCommand(repo, 'rev-parse', '--show-toplevel').replace(/\n$/, ''));
    if (!isNested(workspace, repo)) throw new Error('Git workspace does not contain review path');
    // Capture source and check supported scope before creating any state.
    const action = options.purge !== undefined;
    // A workspace member is captured from its workspace root, so the root
    // lockfile and workspace-relative paths apply; it is selected by manifest.
    const cargo = action ? repo : await cargoRoot(repo, workspace);
    const member = cargo !== repo && (await lstat(join(repo, 'Cargo.toml')).catch(() => undefined))?.isFile() === true;
    const root = member ? cargo : repo;
    const snapshot = action ? undefined : await captureSnapshot(root);
    const inventory = snapshot?.inventory();
    if (inventory && !inventory.has('Cargo.toml')) {
      throw new UsageError('Select a Cargo package directory or specify --program for a nested package');
    }
    selector = options.program !== undefined ? { by: 'name', name: options.program }
      : member ? { by: 'manifest', manifest: relative(root, repo) + '/Cargo.toml' }
      : [...inventory?.keys() ?? []].some(p => p.endsWith('/Cargo.toml')) ? { by: 'sole' } : undefined;
    const before = action ? undefined : gitState(repo);
    await prepareState(options.stateRoot, workspace);
    if (options.purge !== undefined) {
      const result = await purgeReviews({ stateRoot: options.stateRoot, repo, reviewId: options.purge });
      io.stdout(`Deleted ${result.deleted.length} review(s); retained ${result.retained.length}.\n`);
      return result.retained.length ? 1 : 0;
    }
    const expired = await expireReviews({ stateRoot: options.stateRoot, repo, retentionDays: options.retentionDays });
    if (expired.retained.length) io.stderr(`Retention left ${expired.retained.length} review(s) requiring attention.\n`);
    const image = reviewToolsImage();
    const manifest = JSON.parse(readFileSync(new URL('../../engine/runtime-manifest.json', import.meta.url), 'utf8'));
    const result = await runPhaseA({ snapshot: snapshot!,
      scope: { sources: [...inventory!.keys()].filter(p => p.endsWith('.rs')), manifest: 'Cargo.toml',
        ...(inventory!.has('Cargo.lock') ? { lockfile: 'Cargo.lock' } : {}) },
      staticPort: createStaticExecutionPort({ scratchRoot: join(options.stateRoot, 'review-scratch'), image }),
      metadata: { reviewId: randomUUID(), createdAt: new Date().toISOString(), repo: { commit: before!.commit, dirty: before!.dirty } },
      toolVersions: { 'oms-sast': manifest.reviewTools.omsSast, 'cargo-audit': manifest.reviewTools.cargoAudit },
      program: selector });
    result.report.tools.push({ name: 'review-tools-image', version: image, status: 'ok' });
    result.report.tools.push({ name: 'model-review', version: '', status: 'skipped', reason: 'CLI model dispatch is not implemented; static review only' });
    // Porcelain cannot distinguish successive edits to an already-dirty file.
    // Reuse the filtered capture boundary; never broaden reads to excluded keys
    // or follow symlinks merely to check source preservation.
    const current = await captureSnapshot(root);
    const currentInventory = current.inventory();
    if (currentInventory.size !== inventory!.size || [...inventory!.keys()].some(file =>
      !currentInventory.has(file) || current.read(file) !== snapshot!.read(file))) {
      throw new Error('Captured source changed during review');
    }
    const after = gitState(repo);
    if (after.commit !== before!.commit || after.status !== before!.status) throw new Error('Workspace changed during review');
    const saved = await saveReview({ stateRoot: options.stateRoot, repo, report: result.report, files: inventory!, logs: '' });
    // The workspace guard runs before the explicitly requested output write.
    // Export failures retain the private report for recovery.
    if (options.out) {
      try { await exportReview({ out: options.out, report: result.report, files: inventory! }); }
      catch { io.stderr('Private report saved, but export failed. Choose a new directory under an existing non-symlinked parent.\n'); return 1; }
    }
    // Display precisely the redacted, validated artifact that was persisted.
    io.stdout(await readFile(join(saved.directory, options.json ? 'report.json' : 'report.md'), 'utf8'));
    if (io.report) {
      const persisted = JSON.parse(await readFile(join(saved.directory, 'report.json'), 'utf8'));
      io.report({ reviewId: persisted.reviewId, confirmed: persisted.totals.confirmed, suspected: persisted.totals.suspected,
        markdown: await readFile(join(saved.directory, 'report.md'), 'utf8') });
    }
    const failed = result.report.tools.some(t => t.status === 'failed') || result.staticPass.scans.some(s => s.reason === 'Static pass budget exhausted');
    io.stderr(failed ? 'Partial report saved; one or more review stages failed.\n' : 'Phase A report saved in private review state.\n');
    return failed ? 1 : 0;
  } catch (error) {
    if (error instanceof ProgramSelectionError && error.reason !== 'unavailable') {
      io.stderr(error.reason === 'unknown' ? 'Requested program was not discovered; select its Cargo package directory.\n'
        : selector?.by !== 'sole' ? 'Program name is ambiguous; select its Cargo package directory.\n'
        : `Several programs found: ${error.names.map(name => PACKAGE_NAME.test(name) ? name : '?').join(', ')}. Specify --program <name>.\n`);
      return 2;
    }
    if (error instanceof UsageError) { io.stderr(error.message + '\n'); return 2; }
    io.stderr('Review infrastructure failed. Check the local Git checkout, private state directory and pinned review-tools image.\n');
    return 1;
  }
}
