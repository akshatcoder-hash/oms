import { declaresCargoWorkspace, discoverPrograms, type DiscoveryResult } from './discover.ts';
import { mergeFindings } from './merge.ts';
import { emptyReport, prepareReport } from './report/render.ts';
import type { ReviewSnapshot } from './snapshot.ts';
import { runStaticPass, type StaticExecutionPort, type StaticPass, type StaticScope } from './static/run.ts';
import { parseReviewReport, type ReviewReport } from './types.ts';

/** How one package is chosen from a Cargo workspace snapshot. `sole` takes the
 * only discovered program and refuses when there are several. */
export type ProgramSelector = { by: 'name'; name: string } | { by: 'manifest'; manifest: string } | { by: 'sole' };

export class ProgramSelectionError extends Error {
  readonly reason: 'unavailable' | 'unknown' | 'ambiguous';
  /** Candidate program names when the selection is ambiguous. */
  readonly names: string[];
  constructor(reason: 'unavailable' | 'unknown' | 'ambiguous', names: string[] = []) {
    super(`Program selection ${reason}`);
    this.reason = reason;
    this.names = names;
  }
}

export interface PhaseAResult {
  report: ReviewReport;
  discovery: DiscoveryResult;
  staticPass: StaticPass;
}

/** Captured input and explicit trusted Cargo scope only. No build, chain action,
 * persistence, model call or network is performed here. */
export async function runPhaseA(options: {
  snapshot: ReviewSnapshot;
  scope: StaticScope;
  staticPort: StaticExecutionPort;
  metadata: Pick<ReviewReport, 'reviewId' | 'createdAt' | 'repo'>;
  toolVersions: Readonly<Record<'oms-sast' | 'cargo-audit', string>>;
  program?: ProgramSelector;
}): Promise<PhaseAResult> {
  // Capture caller-controlled settings before the first asynchronous boundary.
  const { snapshot, staticPort } = options;
  let scope = structuredClone(options.scope);
  const selector = options.program && structuredClone(options.program);
  const versions = { ...options.toolVersions };
  const report = parseReviewReport(emptyReport(structuredClone(options.metadata)));
  if (Object.values(versions).some((version) => typeof version !== 'string' || version.length > 4096)) {
    throw new Error('Invalid Phase A tool versions');
  }
  // Without a selector, preserve static findings even if discovery is incomplete.
  // Explicit selection requires a complete inventory before scoping analysis.
  let discovery: DiscoveryResult | undefined;
  if (selector !== undefined) {
    discovery = await discoverPrograms(snapshot, staticPort);
    const matches = discovery.programs.filter(
      (p) =>
        selector.by === 'sole' ||
        (selector.by === 'name' ? p.name === selector.name : p.manifest === selector.manifest),
    );
    if (matches.length > 1)
      throw new ProgramSelectionError(
        'ambiguous',
        matches.map((p) => p.name),
      );
    const selected = matches[0];
    // Without a match any issue could hide the program. With one, only its own
    // issues matter, plus unreadable manifests, which could hide a duplicate.
    if (
      discovery.issues.some(
        (issue) =>
          !selected || issue.manifest === selected.manifest || issue.reason === 'Manifest inventory unavailable',
      )
    )
      throw new ProgramSelectionError('unavailable');
    if (!selected) throw new ProgramSelectionError('unknown');
    // Cargo uses a workspace root's lockfile; a member's own lockfile is stale there.
    const inventory = snapshot.inventory();
    const own = selected.manifest.replace(/[^/]*$/, '') + 'Cargo.lock';
    const workspace = inventory.has('Cargo.toml') && declaresCargoWorkspace(snapshot.read('Cargo.toml'));
    const lockfile = (workspace ? ['Cargo.lock', own] : [own, 'Cargo.lock']).find((path) => inventory.has(path));
    scope = { sources: selected.sources, manifest: selected.manifest, ...(lockfile ? { lockfile } : {}) };
    discovery = { programs: [selected], issues: [] };
  }
  const staticPass = await runStaticPass(snapshot, scope, staticPort);
  discovery ??= await discoverPrograms(snapshot, staticPort);
  const files = new Set(scope.sources);
  const programs = discovery.programs.filter((program) => program.sources.every((file) => files.has(file)));
  report.programs = programs.map(({ name, programId, framework }) => ({ name, programId, framework }));
  report.tools = staticPass.scans.map((scan) => ({
    name: scan.tool,
    version: versions[scan.tool],
    status: scan.status,
    reason: [scan.file, scan.reason].filter(Boolean).join(': '),
  }));
  for (const issue of discovery.issues)
    report.tools.push({
      name: 'discovery',
      version: versions['oms-sast'],
      status: 'failed',
      reason: `${issue.file}: ${issue.reason}`,
    });
  if (!programs.length)
    report.tools.push({
      name: 'discovery',
      version: versions['oms-sast'],
      status: 'skipped',
      reason: 'No complete program resolved inside the static scope; handler model review unavailable',
    });
  if (snapshot.excludedFiles)
    report.tools.push({
      name: 'snapshot',
      version: '',
      status: 'skipped',
      reason: `${snapshot.excludedFiles} entries excluded from captured input`,
    });
  const merged = mergeFindings(staticPass.hits, [], snapshot.inventory(), {});
  report.findings = merged.findings;
  report.totals.suspected = report.findings.length;
  report.totals.invalidModelOutputs = merged.invalidModelOutputs;
  if (report.findings.length) delete report.emptyNote;
  // Unresolved modules and omitted files mean the absence of findings cannot
  // establish a clear verdict.
  for (const row of report.coverage)
    if (report.findings.some((f) => f.class === row.class)) {
      row.verdict = 'found';
      row.evidence = 'Suspected static or model finding; no confirmation';
    }
  return { report: prepareReport(report, snapshot.inventory()), discovery, staticPass };
}
