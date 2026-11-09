import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ProgramSelectionError, runPhaseA } from '../src/pipeline.ts';
import { captureSnapshot } from '../src/snapshot.ts';
import { parseReviewReport } from '../src/types.ts';
import { renderJson, renderMarkdown } from '../src/report/render.ts';
import type { StaticExecutionPort } from '../src/static/run.ts';

const metadata = { reviewId: 'test-review', createdAt: '2026-11-08T17:00:00.000Z', repo: { commit: '', dirty: false } };
const source = 'pub fn withdraw() {}\npub fn deposit() {}\n';
const hit = { tool: 'oms-sast', ruleId: 'missing-signer/anchor-field', class: 'missing-signer', severity: 'high',
  location: { file: 'src/lib.rs', line: 1, handler: 'withdraw' }, message: 'Authority needs review' };
const response = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), timedOut: false, truncated: false });
function staticPort(options: { brokenDiscovery?: boolean; failedSource?: boolean } = {}): StaticExecutionPort {
  return { async run(r) {
    assert.equal(r.network, 'none'); assert.equal(r.readOnly, true);
    if (r.argv[1] === '--inventory') {
      if (options.brokenDiscovery) throw new Error('DO NOT PERSIST raw error');
      if (r.argv[2] === 'Cargo.toml') return response({ name: 'vault', framework: 'anchor', libPath: 'src/lib.rs' });
      return response({ programIds: ['11111111111111111111111111111111'], handlers: [
        { name: 'withdraw', file: 'src/lib.rs', line: 1 }, { name: 'deposit', file: 'src/lib.rs', line: 2 },
      ] });
    }
    if (r.argv[1] === '--file') {
      if (options.failedSource) throw new Error('DO NOT PERSIST raw error');
      return response({ hits: [hit], handlers: [], implementedRules: [hit.ruleId] });
    }
    return response({ hits: [], handlers: [], implementedRules: [] });
  } };
}
async function fixture(fn: (base: Parameters<typeof runPhaseA>[0]) => Promise<void>) {
  const parent = resolve('.tmp/pipeline-tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-'));
  const repo = join(root, 'repo'); const stateRoot = join(root, 'state');
  try {
    await mkdir(join(repo, 'src'), { recursive: true }); await mkdir(stateRoot, { mode: 0o700 });
    await writeFile(join(repo, 'src/lib.rs'), source); await writeFile(join(repo, 'Cargo.toml'), '[package]\n');
    const snapshot = await captureSnapshot(repo);
    await fn({ snapshot, scope: { sources: ['src/lib.rs'], manifest: 'Cargo.toml' }, staticPort: staticPort(),
      metadata, toolVersions: { 'oms-sast': 'test', 'cargo-audit': 'test' } });
    assert.equal(await readFile(join(repo, 'src/lib.rs'), 'utf8'), source);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('Phase A defaults to static only and renders a strict suspected report with failure visibility', async () => fixture(async base => {
  const result = await runPhaseA(base);
  assert.equal(result.report, parseReviewReport(result.report));
  assert.equal(result.report.findings.length, 1); assert.equal(result.report.totals.confirmed, 0);
  assert.equal(result.report.model, undefined); assert.equal(result.report.coverage.length, 14);
  assert.equal(result.report.coverage[0]!.verdict, 'found');
  assert.ok(result.report.coverage.slice(1).every(c => c.verdict === 'unreviewed'));
  assert.ok(result.report.tools.some(t => t.name === 'cargo-audit' && t.status === 'skipped'));
  assert.match(renderMarkdown(result.report, base.snapshot.inventory()), /Not a professional audit/);
  parseReviewReport(JSON.parse(renderJson(result.report, base.snapshot.inventory())));
}));

test('discovery failure does not discard static evidence', async () => fixture(async base => {
  const r = await runPhaseA({ ...base, staticPort: staticPort({ brokenDiscovery: true }) });
  assert.equal(r.report.findings.length, 1);
  assert.ok(r.report.tools.some(t => t.name === 'discovery' && t.status === 'failed'));
  assert.ok(!JSON.stringify(r).includes('DO NOT PERSIST'));
}));

test('failed static analysis and empty discovery never become clear coverage', async () => fixture(async base => {
  const r = await runPhaseA({ ...base, staticPort: staticPort({ failedSource: true, brokenDiscovery: true }) });
  assert.equal(r.report.findings.length, 0); assert.match(r.report.emptyNote!, /does not mean/);
  assert.ok(r.report.coverage.every(c => c.verdict === 'unreviewed'));
  assert.ok(r.report.tools.some(t => t.status === 'failed'));
}));

test('selected nested program without its own lockfile uses the workspace root lockfile', async () => fixture(async base => {
  const files = new Map([
    ['Cargo.toml', '[workspace]\n'], ['Cargo.lock', 'root lockfile'],
    ['programs/vault/Cargo.toml', '[package]\n'],
    ['programs/vault/src/lib.rs', source], ['src/unrelated.rs', 'unrelated source'],
  ]);
  const scans: Array<readonly string[]> = [];
  const result = await runPhaseA({ ...base, program: { by: 'name', name: 'vault' },
    snapshot: { excludedFiles: 0, inventory: () => new Map([...files].map(([file, text]) => [file, text.split('\n').length])),
      read(file) { assert.ok(files.has(file)); return files.get(file)!; }, grep() { return []; } },
    staticPort: { async run(request) {
      const file = request.argv[2]!;
      if (request.argv[1] === '--inventory') {
        if (file === 'Cargo.toml') return response({ name: null, framework: null, libPath: 'src/lib.rs' });
        if (file.endsWith('Cargo.toml')) return response({ name: 'vault', framework: 'anchor', libPath: 'src/lib.rs' });
        return response({ programIds: ['11111111111111111111111111111111'], handlers: [{ name: 'withdraw', file, line: 1 }] });
      }
      scans.push(request.argv);
      return response({ hits: [], handlers: [], implementedRules: [] });
    } },
  });
  assert.deepEqual(scans.map(argv => argv.includes('--lockfile') ? argv[argv.indexOf('--lockfile') + 1] : null).slice(0, 1), ['Cargo.lock']);
  assert.ok(scans.some(argv => argv[0] === 'cargo-audit' && argv.includes('/work/Cargo.lock')));
  assert.deepEqual(result.report.programs.map(p => p.name), ['vault']);
  assert.equal(result.report.tools.some(t => t.name === 'workspace-dependencies'), false);
}));

/** In-memory workspace: each manifest maps to its inventory metadata. */
function workspace(files: Record<string, string>, manifests: Record<string, unknown>) {
  const scans: Array<readonly string[]> = [];
  const snapshot = { excludedFiles: 0, inventory: () => new Map(Object.entries(files).map(([file, text]) => [file, text.split('\n').length])),
    read(file: string) { assert.ok(file in files); return files[file]!; }, grep() { return []; } };
  const staticPort: StaticExecutionPort = { async run(request) {
    const file = request.argv[2]!;
    if (request.argv[1] === '--inventory') {
      if (file in manifests) {
        if (manifests[file] === 'unreadable') throw new Error('unreadable');
        return response(manifests[file]);
      }
      return response({ programIds: ['11111111111111111111111111111111'], handlers: [{ name: 'withdraw', file, line: 1 }] });
    }
    scans.push(request.argv);
    return response({ hits: [], handlers: [], implementedRules: [] });
  } };
  return { snapshot, staticPort, scans };
}
const anchor = (name: string) => ({ name, framework: 'anchor', libPath: 'src/lib.rs' });
const virtualRoot = { name: null, framework: null, libPath: 'src/lib.rs' };

test('an unrelated crate without a Solana framework does not block program selection', async () => fixture(async base => {
  const files = { 'Cargo.toml': '[workspace]\n', 'programs/vault/Cargo.toml': '[package]\n', 'programs/vault/src/lib.rs': source,
    'cli/Cargo.toml': '[package]\n', 'cli/src/lib.rs': 'fn main() {}\n' };
  const { snapshot, staticPort } = workspace(files, { 'Cargo.toml': virtualRoot, 'programs/vault/Cargo.toml': anchor('vault'),
    'cli/Cargo.toml': { name: 'cli', framework: null, libPath: 'src/lib.rs' } });
  const result = await runPhaseA({ ...base, snapshot, staticPort, program: { by: 'name', name: 'vault' } });
  assert.deepEqual(result.report.programs.map(p => p.name), ['vault']);
  // An unreadable manifest could still hide a second package with the same name.
  const unreadable = workspace(files, { 'Cargo.toml': virtualRoot, 'programs/vault/Cargo.toml': anchor('vault'), 'cli/Cargo.toml': 'unreadable' });
  await assert.rejects(runPhaseA({ ...base, ...unreadable, program: { by: 'name', name: 'vault' } }),
    (error: ProgramSelectionError) => error.reason === 'unavailable');
}));

test('a workspace root lockfile wins over a stale member lockfile', async () => fixture(async base => {
  const { snapshot, staticPort, scans } = workspace({ 'Cargo.toml': '[workspace]\nmembers = ["programs/vault"]\n', 'Cargo.lock': 'root',
    'programs/vault/Cargo.toml': '[package]\n', 'programs/vault/Cargo.lock': 'stale', 'programs/vault/src/lib.rs': source },
  { 'Cargo.toml': virtualRoot, 'programs/vault/Cargo.toml': anchor('vault') });
  await runPhaseA({ ...base, snapshot, staticPort, program: { by: 'name', name: 'vault' } });
  assert.ok(scans.some(argv => argv[0] === 'cargo-audit' && argv.includes('/work/Cargo.lock')));
  assert.ok(!scans.some(argv => argv.some(arg => arg.includes('programs/vault/Cargo.lock'))));
}));

test('a package is selected by manifest path, or automatically when it is the only program', async () => fixture(async base => {
  const files = { 'Cargo.toml': '[workspace]\n', 'programs/a/Cargo.toml': '[package]\n', 'programs/a/src/lib.rs': source,
    'programs/b/Cargo.toml': '[package]\n', 'programs/b/src/lib.rs': source };
  const both = workspace(files, { 'Cargo.toml': virtualRoot, 'programs/a/Cargo.toml': anchor('a'), 'programs/b/Cargo.toml': anchor('b') });
  const byManifest = await runPhaseA({ ...base, ...both, program: { by: 'manifest', manifest: 'programs/b/Cargo.toml' } });
  assert.deepEqual(byManifest.report.programs.map(p => p.name), ['b']);
  await assert.rejects(runPhaseA({ ...base, ...both, program: { by: 'sole' } }),
    (error: ProgramSelectionError) => error.reason === 'ambiguous' && error.names.join() === 'a,b');
  const one = workspace(files, { 'Cargo.toml': virtualRoot, 'programs/a/Cargo.toml': anchor('a'),
    'programs/b/Cargo.toml': { name: 'b-cli', framework: null, libPath: 'src/lib.rs' } });
  const sole = await runPhaseA({ ...base, ...one, program: { by: 'sole' } });
  assert.deepEqual(sole.report.programs.map(p => p.name), ['a']);
}));
