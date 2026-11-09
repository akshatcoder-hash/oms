import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runReviewCommand } from '../src/review.ts';
import { parseReviewReport } from '../../review/src/types.ts';
import { REVIEW_DISCLAIMER } from '../../review/src/disclaimer.ts';
import { emptyReport, saveReview } from '../../review/src/index.ts';
import { configuredReviewToolsImage } from '../../engine/src/runtime/review-ports.ts';
import { reviewToolsSkip } from '../../sandbox/test-support/infrastructure.ts';

async function fixture() {
  const parent = resolve('.tmp/review-cli'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-'));
  const repo = join(root, 'repo'); const state = join(root, 'state');
  await cp(new URL('../../review/test/fixtures/discovery/anchor-vault', import.meta.url), repo, { recursive: true });
  await mkdir(state, { mode: 0o700 });
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
  const stdout: string[] = []; const stderr: string[] = [];
  return { root, repo, state, stdout, stderr,
    io: { stdout: (s: string) => { stdout.push(s); }, stderr: (s: string) => { stderr.push(s); } },
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('review rejects unsupported options before state writes and always displays the disclaimer', async () => {
  const f = await fixture();
  try {
    for (const args of [['--phase', 'B'], ['--replay', 'id/finding'], ['--out', 'out'],
      ['--phase', 'A', '--phase', 'A'], ['--purge'], ['--unknown'], ['--with', 'xray']]) {
      f.stdout.length = 0; f.stderr.length = 0;
      assert.equal(await runReviewCommand([f.repo, '--state-root', f.state, ...args], f.io), 2);
      assert.match(f.stderr.join(''), /Not a professional audit/);
      assert.deepEqual(await readdir(f.state), []);
    }
  } finally { await f.cleanup(); }
});

test('review help is keyless and purge is repo-scoped without starting static tools', async () => {
  const f = await fixture();
  try {
    assert.equal(await runReviewCommand(['--help'], f.io), 0);
    assert.match(f.stdout.join(''), /oms review/);
    f.stdout.length = 0;
    assert.equal(await runReviewCommand([f.repo, '--state-root', f.state, '--purge', 'all'], f.io), 0);
    assert.match(f.stdout.join(''), /Deleted 0/);
    assert.deepEqual(await readdir(f.state), []);
  } finally { await f.cleanup(); }
});

const skip = reviewToolsSkip(configuredReviewToolsImage());

test('review selects the discovered package by name and refuses an unknown program', { skip }, async () => {
  const f = await fixture();
  try {
    const base = [f.repo, '--phase', 'A', '--json', '--state-root', f.state];
    assert.equal(await runReviewCommand([...base, '--program', 'anchor-vault'], f.io), 0, f.stderr.join(''));
    const report = parseReviewReport(JSON.parse(f.stdout.join('')));
    assert.deepEqual(report.programs.map(p => p.name), ['anchor-vault']);
    const scopes = await readdir(join(f.state, 'reviews'));
    const reports = join(f.state, 'reviews', scopes[0]!);
    const saved = await readdir(reports);
    f.stdout.length = 0;
    const out = join(f.root, 'unknown-export');
    assert.equal(await runReviewCommand([...base, '--program', 'absent', '--out', out], f.io), 2);
    assert.equal(f.stdout.join(''), '');
    assert.deepEqual(await readdir(reports), saved);
    assert.ok(!(await readdir(f.root)).includes('unknown-export'));
    assert.equal(execFileSync('git', ['-C', f.repo, 'status', '--porcelain=v1'], { encoding: 'utf8' }), '');
  } finally { await f.cleanup(); }
});

test('program selection rejects invalid names and action conflicts before writes', async () => {
  const f = await fixture();
  try {
    for (const name of ['', '../vault', 'vault\n', 'a'.repeat(257)]) {
      assert.equal(await runReviewCommand([f.repo, '--state-root', f.state, '--phase', 'A', '--program', name], f.io), 2);
    }
    for (const action of [['--purge', 'all']]) {
      assert.equal(await runReviewCommand([f.repo, '--state-root', f.state, ...action, '--program', 'anchor-vault'], f.io), 2);
    }
    assert.deepEqual(await readdir(f.state), []);
  } finally { await f.cleanup(); }
});

test('program selection treats unavailable discovery as infrastructure failure, not an unknown name', { skip }, async () => {
  const f = await fixture();
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(f.repo, 'src/lib.rs'), 'not valid Rust ! {');
    assert.equal(await runReviewCommand([f.repo, '--phase', 'A', '--program', 'anchor-vault', '--json', '--state-root', f.state], f.io), 1);
    assert.equal(f.stdout.join(''), '');
    assert.ok(!(await readdir(f.state)).includes('reviews'));
    assert.match(f.stderr.join(''), /Review infrastructure failed/);
  } finally { await f.cleanup(); }
});

test('review Phase A uses real offline tools, persists valid JSON and leaves the git tree unchanged', { skip }, async () => {
  const f = await fixture();
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', f.repo, ...args], { encoding: 'utf8' });
    const tree = git('write-tree'); const status = git('status', '--porcelain=v1');
    const source = await readFile(join(f.repo, 'src/lib.rs'), 'utf8');
    let presented: import('../src/review.ts').ReviewPresentation | undefined;
    assert.equal(await runReviewCommand([f.repo, '--phase', 'A', '--json', '--state-root', f.state],
      { ...f.io, report: report => { presented = report; } }), 0, f.stderr.join(''));
    assert.ok(presented);
    assert.match(presented.markdown, /Not a professional audit/);
    const outputReport = JSON.parse(f.stdout.join(''));
    assert.equal(presented.reviewId, outputReport.reviewId);
    assert.equal(presented.confirmed, outputReport.totals.confirmed);
    assert.equal(presented.suspected, outputReport.totals.suspected);
    const report = parseReviewReport(JSON.parse(f.stdout.join('')));
    assert.equal(report.disclaimer, REVIEW_DISCLAIMER);
    assert.equal(report.phase, 'A'); assert.equal(report.model, undefined);
    assert.equal(report.repo.commit, git('rev-parse', 'HEAD').trim()); assert.equal(report.repo.dirty, false);
    assert.ok(report.findings.length > 0); assert.equal(report.totals.confirmed, 0);
    assert.ok(report.tools.some(t => t.name === 'oms-sast' && t.status === 'ok'));
    const repos = await readdir(join(f.state, 'reviews'));
    const saved = join(f.state, 'reviews', repos[0]!, report.reviewId);
    assert.deepEqual(JSON.parse(await readFile(join(saved, 'report.json'), 'utf8')), report);
    assert.equal(git('write-tree'), tree); assert.equal(git('status', '--porcelain=v1'), status);
    assert.equal(await readFile(join(f.repo, 'src/lib.rs'), 'utf8'), source);
    f.stdout.length = 0;
    assert.equal(await runReviewCommand([f.repo, '--state-root', f.state, '--purge', report.reviewId], f.io), 0);
    assert.deepEqual(await readdir(join(f.state, 'reviews', repos[0]!)), []);
  } finally { await f.cleanup(); }
});

test('CLI review registration exposes help without initializing a session', () => {
  const result = execFileSync(process.execPath, [new URL('../src/bin.ts', import.meta.url).pathname, 'review', '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(result, /oms review/); assert.match(result, /Phase A/);
});

test('review retention option rejects invalid values and action conflicts before writes', async () => {
  const f = await fixture();
  try {
    for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '1e2', '0x10', '9007199254740991']) {
      assert.equal(await runReviewCommand([f.repo, '--state-root', f.state, '--phase', 'A', '--retention-days', value], f.io), 2);
      assert.deepEqual(await readdir(f.state), []);
    }
    for (const action of [['--purge', 'all']]) {
      assert.equal(await runReviewCommand([f.repo, '--state-root', f.state, ...action, '--retention-days', '7'], f.io), 2);
      assert.deepEqual(await readdir(f.state), []);
    }
    assert.equal(await runReviewCommand([f.repo, '--state-root', f.state, '--phase', 'A', '--retention-days', '7', '--retention-days', '8'], f.io), 2);
    assert.deepEqual(await readdir(f.state), []);
  } finally { await f.cleanup(); }
});

test('review startup applies custom retention to this checkout and keeps the default at 30 days', { skip }, async () => {
  const f = await fixture();
  try {
    const other = join(f.root, 'other'); await mkdir(other);
    const save = (repo: string, reviewId: string, age: number) => saveReview({ repo, stateRoot: f.state,
      report: emptyReport({ reviewId, createdAt: new Date(Date.now() - age * 86400000).toISOString(),
        repo: { commit: '', dirty: false } }), files: new Map(), logs: '' });
    const old = await save(f.repo, 'old', 10);
    const recent = await save(f.repo, 'recent', 1);
    const foreign = await save(other, 'other-old', 10);
    const base = [f.repo, '--state-root', f.state, '--phase', 'A', '--json'];
    assert.equal(await runReviewCommand(base, f.io), 0, f.stderr.join(''));
    await readFile(join(old.directory, 'report.json'));
    assert.equal(await runReviewCommand([...base, '--retention-days', '7'], f.io), 0, f.stderr.join(''));
    await assert.rejects(readFile(join(old.directory, 'report.json')), { code: 'ENOENT' });
    await readFile(join(recent.directory, 'report.json'));
    await readFile(join(foreign.directory, 'report.json'));
    assert.equal(execFileSync('git', ['-C', f.repo, 'status', '--porcelain=v1'], { encoding: 'utf8' }), '');
  } finally { await f.cleanup(); }
});

test('failed real static analysis saves a partial report and returns infrastructure exit 1', { skip }, async () => {
  const f = await fixture();
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(f.repo, 'src/lib.rs'), 'not valid Rust ! {');
    const code = await runReviewCommand([f.repo, '--phase', 'A', '--json', '--state-root', f.state], f.io);
    assert.equal(code, 1);
    const report = parseReviewReport(JSON.parse(f.stdout.join('')));
    assert.equal(report.repo.dirty, true); assert.ok(report.tools.some(t => t.status === 'failed'));
    assert.match(f.stderr.join(''), /Partial report saved/);
    assert.equal(await readFile(join(f.repo, 'src/lib.rs'), 'utf8'), 'not valid Rust ! {');
  } finally { await f.cleanup(); }
});

test('review refuses state anywhere inside the enclosing git checkout before creating it', async () => {
  const f = await fixture();
  try {
    const nested = join(f.repo, 'programs', 'vault');
    await mkdir(join(f.repo, 'programs'));
    await cp(new URL('../../review/test/fixtures/discovery/anchor-vault', import.meta.url), nested, { recursive: true });
    const state = join(f.repo, '.review-state');
    assert.equal(await runReviewCommand([nested, '--phase', 'A', '--state-root', state], f.io), 1);
    assert.ok(!(await readdir(f.repo)).includes('.review-state'));
    assert.equal(await runReviewCommand([nested, '--purge', 'all', '--state-root', state], f.io), 1);
    assert.ok(!(await readdir(f.repo)).includes('.review-state'));
  } finally { await f.cleanup(); }
});

test('review does not invoke configured git clean filters on the host', async () => {
  const f = await fixture();
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(f.repo, '.gitattributes'), '*.rs filter=probe\n');
    await writeFile(join(f.repo, 'src/lib.rs'), 'pub fn changed() {}');
    execFileSync('git', ['-C', f.repo, 'config', 'filter.probe.clean', 'touch filter-ran; cat']);
    assert.equal(await runReviewCommand([f.repo, '--phase', 'A', '--state-root', f.state], f.io), 1);
    assert.ok(!(await readdir(f.repo)).includes('filter-ran'));
    assert.deepEqual(await readdir(f.state), []);
  } finally { await f.cleanup(); }
});

test('review rejects control-character paths without creating state in an ambiguously named checkout', async () => {
  const f = await fixture();
  try {
    const { rename } = await import('node:fs/promises');
    const repo = f.repo + '\n'; await rename(f.repo, repo); await mkdir(f.repo);
    assert.equal(await runReviewCommand([repo, '--purge', 'all', '--state-root', join(repo, 'state')], f.io), 2);
    assert.ok(!(await readdir(repo)).includes('state'));
    assert.equal(await runReviewCommand([repo, '--phase', 'A', '--state-root', f.state], f.io), 2);
    assert.deepEqual(await readdir(f.state), []);
  } finally { await f.cleanup(); }
});

test('explicit Phase A export writes only reports to the chosen workspace directory', { skip }, async () => {
  const f = await fixture();
  try {
    const out = join(f.repo, 'review-output');
    const source = await readFile(join(f.repo, 'src/lib.rs'), 'utf8');
    assert.equal(await runReviewCommand([f.repo, '--phase', 'A', '--json', '--state-root', f.state, '--out', out], f.io), 0, f.stderr.join(''));
    assert.deepEqual((await readdir(out)).sort(), ['report.json', 'report.md']);
    assert.equal(await readFile(join(out, 'report.json'), 'utf8'), f.stdout.join(''));
    assert.equal(await readFile(join(f.repo, 'src/lib.rs'), 'utf8'), source);
    const status = execFileSync('git', ['-C', f.repo, 'status', '--porcelain=v1'], { encoding: 'utf8' });
    assert.equal(status, '?? review-output/\n');
  } finally { await f.cleanup(); }
});

test('out cannot accompany purge and cannot target private state', async () => {
  const f = await fixture();
  try {
    for (const args of [['--purge', 'all']]) {
      assert.equal(await runReviewCommand([f.repo, '--state-root', f.state, ...args, '--out', join(f.root, 'out')], f.io), 2);
    }
    assert.equal(await runReviewCommand([f.repo, '--phase', 'A', '--state-root', f.state, '--out', join(f.state, 'export')], f.io), 2);
    assert.deepEqual(await readdir(f.state), []);
  } finally { await f.cleanup(); }
});

test('failed explicit export preserves existing output and the new private report', { skip }, async () => {
  const f = await fixture();
  try {
    const out = join(f.root, 'existing'); await mkdir(out);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(out, 'report.md'), 'keep');
    assert.equal(await runReviewCommand([f.repo, '--phase', 'A', '--state-root', f.state, '--out', out], f.io), 1);
    assert.equal(await readFile(join(out, 'report.md'), 'utf8'), 'keep');
    assert.deepEqual(await readdir(out), ['report.md']);
    assert.match(f.stderr.join(''), /Private report saved, but export failed/);
    const repos = await readdir(join(f.state, 'reviews'));
    const reviews = await readdir(join(f.state, 'reviews', repos[0]!));
    assert.equal(reviews.length, 1);
    const report = parseReviewReport(JSON.parse(await readFile(join(f.state, 'reviews', repos[0]!, reviews[0]!, 'report.json'), 'utf8')));
    assert.equal(report.phase, 'A');
  } finally { await f.cleanup(); }
});

test('review refuses a report when already-dirty source changes during static analysis', { skip }, async () => {
  const f = await fixture();
  const { watch, writeFileSync } = await import('node:fs');
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    const source = join(f.repo, 'src/lib.rs');
    const original = await readFile(source, 'utf8');
    writeFileSync(source, original + '\n// first edit\n');
    const status = () => execFileSync('git', ['-C', f.repo, 'status', '--porcelain=v1'], { encoding: 'utf8' });
    const before = status();
    let changed = false;
    // Scratch creation happens after the CLI captured its input. Change an
    // already-dirty file so porcelain and HEAD remain identical.
    watcher = watch(f.state, (_event, filename) => {
      if (filename === 'review-scratch' && !changed) {
        changed = true;
        writeFileSync(source, original + '\n// later edit\n');
      }
    });
    const code = await runReviewCommand([f.repo, '--phase', 'A', '--json', '--state-root', f.state], f.io);
    assert.equal(changed, true, 'concurrent edit must occur during review');
    assert.equal(status(), before, 'porcelain alone cannot detect this edit');
    assert.equal(code, 1);
    assert.equal(f.stdout.join(''), '');
    assert.ok(!(await readdir(f.state)).includes('reviews'), 'changed input must not produce a saved report');
    assert.equal(await readFile(source, 'utf8'), original + '\n// later edit\n');
  } finally { watcher?.close(); await f.cleanup(); }
});


test('workspace program selection scopes findings and preserves workspace source paths', { skip }, async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.repo, 'programs'));
    await cp(new URL('../../review/test/fixtures/discovery/anchor-vault', import.meta.url), join(f.repo, 'programs/vault'), { recursive: true });
    await writeFile(join(f.repo, 'Cargo.toml'), '[workspace]\nmembers = ["programs/vault"]\n');
    await rm(join(f.repo, 'idl'), { recursive: true });
    // This unrelated source must never become a finding for the selected program.
    await writeFile(join(f.repo, 'src/lib.rs'), 'not valid Rust ! {');
    const status = () => execFileSync('git', ['-C', f.repo, 'status', '--porcelain=v1'], { encoding: 'utf8' });
    const before = status();
    const base = [f.repo, '--phase', 'A', '--json', '--state-root', f.state];
    // The only program in the workspace is selected without --program.
    assert.equal(await runReviewCommand(base, f.io), 0, f.stderr.join(''));
    assert.deepEqual(parseReviewReport(JSON.parse(f.stdout.join(''))).programs.map(p => p.name), ['anchor-vault']);
    f.stdout.length = 0;
    assert.equal(await runReviewCommand([...base, '--program', 'anchor-vault'], f.io), 0, f.stderr.join(''));
    const report = parseReviewReport(JSON.parse(f.stdout.join('')));
    assert.deepEqual(report.programs.map(p => p.name), ['anchor-vault']);
    assert.ok(report.findings.length > 0);
    assert.ok(report.findings.every(finding => finding.location.file.startsWith('programs/vault/')));
    assert.equal(report.tools.some(t => t.status === 'failed'), false);
    assert.equal(report.model, undefined);
    assert.equal(report.tools.some(t => t.name === 'workspace-dependencies'), false);
    assert.equal(status(), before);
    // Ambiguous IDL mapping makes inventory incomplete; do not select from it.
    await cp(join(f.repo, 'programs/vault/idl'), join(f.repo, 'idl'), { recursive: true });
    f.stdout.length = 0;
    assert.equal(await runReviewCommand([...base, '--program', 'anchor-vault'], f.io), 1);
    assert.equal(f.stdout.join(''), '');
    await rm(join(f.repo, 'idl'), { recursive: true });
    // Same package name in a second directory must never silently pick one.
    await cp(join(f.repo, 'programs/vault'), join(f.repo, 'programs/duplicate'), { recursive: true });
    f.stdout.length = 0;
    assert.equal(await runReviewCommand([...base, '--program', 'anchor-vault'], f.io), 2);
    assert.equal(f.stdout.join(''), '');
    assert.match(f.stderr.join(''), /ambiguous/i);
    // Several programs and no selection: refuse, naming the candidates.
    f.stderr.length = 0;
    assert.equal(await runReviewCommand(base, f.io), 2);
    assert.match(f.stderr.join(''), /anchor-vault, anchor-vault.*--program/);
  } finally { await f.cleanup(); }
});

test('reviewing a member directory reads the workspace root and audits its root lockfile', { skip }, async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.repo, 'programs'));
    await cp(new URL('../../review/test/fixtures/discovery/anchor-vault', import.meta.url), join(f.repo, 'programs/vault'), { recursive: true });
    await writeFile(join(f.repo, 'Cargo.toml'), '[workspace]\nmembers = ["programs/vault"]\n');
    await writeFile(join(f.repo, 'Cargo.lock'), 'version = 3\n\n[[package]]\nname = "anchor-lang"\nversion = "1.0.1"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n');
    await rm(join(f.repo, 'idl'), { recursive: true });
    await rm(join(f.repo, 'src'), { recursive: true });
    assert.equal(await runReviewCommand([join(f.repo, 'programs/vault'), '--phase', 'A', '--json', '--state-root', f.state], f.io), 0, f.stderr.join(''));
    const report = parseReviewReport(JSON.parse(f.stdout.join('')));
    assert.deepEqual(report.programs.map(p => p.name), ['anchor-vault']);
    assert.ok(report.tools.some(t => t.name === 'cargo-audit' && t.status === 'ok'));
    assert.ok(report.findings.some(finding => finding.location.file === 'Cargo.lock'));
    assert.ok(report.findings.every(finding => finding.location.file === 'Cargo.lock' || finding.location.file.startsWith('programs/vault/')));
  } finally { await f.cleanup(); }
});
