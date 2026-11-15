import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { DockerClient, CaptureOptions } from '@oms/sandbox';
import { configuredReviewToolsImage, createStaticExecutionPort, reviewToolsImage } from '../src/review-ports.ts';
import { reviewToolsSkip } from '../../sandbox/test-support/infrastructure.ts';
import { runStaticPass, type StaticRequest } from '@oms/review';
import { captureSnapshot } from '@oms/review/snapshot';

async function scratch() {
  const parent = resolve('.tmp/review-port-tests');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return mkdtemp(join(parent, 'case-'));
}
const image = `sha256:${'a'.repeat(64)}`;
const request = (): StaticRequest => ({ tool: 'oms-sast', argv: ['oms-sast', '--file', 'src/lib.rs'],
  files: new Map([['src/lib.rs', 'pub fn handler() {}']]), cwd: '/work', network: 'none', readOnly: true,
  timeoutMs: 300000, outputBytes: 1024 });
function daemon(capture: (o: CaptureOptions) => Promise<number> = async o => { o.stdout(Buffer.from('{}')); return 0; }) {
  const calls: string[][] = [];
  let create: string[] = [];
  const docker: DockerClient = {
    async out(args) {
      calls.push(args);
      if (args[0] === 'create') { create = args; return 'b'.repeat(64); }
      if (args[0] === 'inspect') return JSON.stringify({ Name: '/' + create[create.indexOf('--name') + 1], Id: 'b'.repeat(64),
        Config: { Labels: Object.fromEntries(create.flatMap((arg, i) => arg === '--label' ? [create[i + 1]!.split('=')] : [])) } });
      if (args[0] === 'rm') return '';
      throw new Error('Unexpected Docker request');
    },
    async capture(args, options) { calls.push(args); return capture(options); },
  };
  return { docker, calls };
}

test('static adapter materializes only captured bytes and enforces Docker isolation', async () => {
  const root = await scratch();
  const fake = daemon(async options => {
    const create = fake.calls[0]!;
    const mount = create[create.indexOf('-v') + 1]!;
    const dir = mount.slice(0, -'/work:ro'.length - 1);
    assert.equal(await readFile(join(dir, 'src/lib.rs'), 'utf8'), 'pub fn handler() {}');
    assert.deepEqual(await readdir(dir), ['src']);
    options.stdout(Buffer.from('{}')); return 0;
  });
  try {
    const result = await createStaticExecutionPort({ scratchRoot: root, image }, fake.docker).run(request());
    assert.deepEqual(result, { exitCode: 0, stdout: '{}', timedOut: false, truncated: false });
    const args = fake.calls[0]!;
    for (const [flag, value] of [['--network', 'none'], ['--memory', '2048m'], ['--cpus', '2'], ['--pids-limit', '256'],
      ['--log-driver', 'none'], ['--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m'], ['--cap-drop', 'ALL']]) {
      assert.equal(args[args.indexOf(flag!) + 1], value);
    }
    assert.ok(args.includes('--read-only')); assert.ok(args.includes('--pull=never'));
    assert.deepEqual(args.filter((_, i) => args[i - 1] === '--env'), ['HOME=/tmp', 'CARGO_HOME=/tmp/cargo']);
    assert.deepEqual(args.slice(args.indexOf(image)), [image, ...request().argv]);
    assert.equal(fake.calls.at(-1)![0], 'rm');
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('static adapter rejects commands, paths, limits and extra inputs before Docker', async () => {
  const root = await scratch(); const fake = daemon();
  try {
    const port = createStaticExecutionPort({ scratchRoot: root, image }, fake.docker);
    for (const patch of [
      { argv: ['sh', '-c', 'true'] }, { argv: ['oms-sast', '--file', 'src/lib.rs', '--extra'] },
      { files: new Map([['../lib.rs', 'x']]) }, { files: new Map([['src/lib.rs', 'x'], ['.env', 'x']]) },
      { files: new Map([['src/lib.rs', 'x'.repeat(512 * 1024 + 1)]]) }, { timeoutMs: 300001 }, { outputBytes: Infinity },
    ]) await assert.rejects(port.run({ ...request(), ...patch }));
    assert.deepEqual(fake.calls, []); assert.deepEqual(await readdir(root), []);
    assert.throws(() => createStaticExecutionPort({ scratchRoot: root, image: 'latest' }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('static adapter bounds both output streams, times out and removes its container', async () => {
  const root = await scratch();
  try {
    for (const stream of ['stdout', 'stderr'] as const) {
      const fake = daemon(async o => { o[stream](Buffer.alloc(2048, 120)); assert.ok(o.signal.aborted); return 130; });
      const result = await createStaticExecutionPort({ scratchRoot: root, image }, fake.docker).run(request());
      assert.equal(result.truncated, true); assert.equal(result.timedOut, false);
      assert.ok(Buffer.byteLength(result.stdout) <= 1024); assert.equal(fake.calls.at(-1)![0], 'rm');
    }
    const fake = daemon(async o => { if (!o.signal.aborted) await new Promise<void>(resolve => o.signal.addEventListener('abort', () => resolve(), { once: true })); return 130; });
    const result = await createStaticExecutionPort({ scratchRoot: root, image }, fake.docker).run({ ...request(), timeoutMs: 50 });
    assert.equal(result.timedOut, true); assert.equal(result.exitCode, 124);
    assert.equal(fake.calls.at(-1)![0], 'rm'); assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('static adapter withholds success and retains inputs when cleanup fails', async () => {
  const root = await scratch(); const fake = daemon();
  const original = fake.docker.out;
  fake.docker.out = async args => { if (args[0] === 'rm') throw new Error('private daemon diagnostic'); return original(args); };
  try {
    await assert.rejects(createStaticExecutionPort({ scratchRoot: root, image }, fake.docker).run(request()),
      /^Error: Static container cleanup failed; retained inputs require host recovery$/);
    assert.equal((await readdir(root)).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('review-tools image comes from the host receipt or OMS_REVIEW_TOOLS_IMAGE, never the committed manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../engine/runtime-manifest.json', import.meta.url), 'utf8'));
  assert.equal('reviewToolsImages' in manifest, false);
  const previous = process.env.OMS_REVIEW_TOOLS_IMAGE;
  try {
    process.env.OMS_REVIEW_TOOLS_IMAGE = `sha256:${'a'.repeat(64)}`;
    assert.equal(reviewToolsImage(), `sha256:${'a'.repeat(64)}`);
    process.env.OMS_REVIEW_TOOLS_IMAGE = 'oms-review-tools:local';
    assert.throws(() => configuredReviewToolsImage());
  } finally {
    if (previous === undefined) delete process.env.OMS_REVIEW_TOOLS_IMAGE; else process.env.OMS_REVIEW_TOOLS_IMAGE = previous;
  }
});

test('missing review-tools image skips, while OMS_REQUIRE_REVIEW_TOOLS fails without a green skip', () => {
  const helper = new URL('../../sandbox/test-support/infrastructure.ts', import.meta.url).href;
  const script = `import { test } from 'node:test'; import { reviewToolsSkip } from ${JSON.stringify(helper)}; test('missing review tools', { skip: reviewToolsSkip(undefined) }, () => {});`;
  const run = (required: string) => execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, OMS_REQUIRE_REVIEW_TOOLS: required }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(run('0'), /SKIP|skipped/i);
  assert.throws(() => run('1'), /OMS_REQUIRE_REVIEW_TOOLS=1/);
});

const skip = reviewToolsSkip(configuredReviewToolsImage());
test('production static port runs captured Rust and offline advisory checks in real Docker', { skip }, async () => {
  const root = await scratch();
  try {
    const repo = join(root, 'repo'); await mkdir(repo);
    await writeFile(join(repo, 'lib.rs'), "struct Withdraw<'info> { authority: UncheckedAccount<'info> }\npub fn withdraw() {}\n");
    await writeFile(join(repo, 'Cargo.lock'), 'version = 3\n[[package]]\nname = "anchor-lang"\nversion = "1.0.1"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n');
    const snapshot = await captureSnapshot(repo);
    const state = join(root, 'state');
    const result = await runStaticPass(snapshot, { sources: ['lib.rs'], lockfile: 'Cargo.lock' }, createStaticExecutionPort({ scratchRoot: state }));
    assert.deepEqual(result.scans.filter(s => s.status !== 'skipped').map(s => s.status), ['ok', 'ok']);
    assert.ok(result.hits.some(h => h.class === 'missing-signer'));
    assert.ok(result.hits.some(h => h.ruleId === 'RUSTSEC-2026-0144'));
    assert.deepEqual(await readdir(state), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('timeout during container creation waits for creation and cleans up without starting it', async () => {
  const root = await scratch();
  const fake = daemon(async () => { assert.fail('Expired container must never start'); });
  const original = fake.docker.out;
  let creationFinished = false;
  fake.docker.out = async (args, signal) => {
    if (args[0] === 'create') {
      assert.equal(signal, undefined, 'creation must not be interrupted mid-mutation');
      const id = await original(args);
      await new Promise(resolve => setTimeout(resolve, 100));
      creationFinished = true;
      return id;
    }
    assert.equal(creationFinished, true, 'cleanup must await creation');
    return original(args);
  };
  try {
    const result = await createStaticExecutionPort({ scratchRoot: root, image }, fake.docker).run({ ...request(), timeoutMs: 50 });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 124);
    assert.deepEqual(fake.calls.map(args => args[0]), ['create', 'inspect', 'rm']);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed creation still removes a potentially created container before deleting its inputs', async () => {
  const root = await scratch();
  const fake = daemon(async () => { assert.fail('Failed creation must never attach'); });
  const original = fake.docker.out;
  fake.docker.out = async args => {
    const result = await original(args);
    if (args[0] === 'create') throw new Error('private creation diagnostic');
    if (args[0] === 'rm') assert.equal((await readdir(root)).length, 1, 'inputs remain until removal completes');
    return result;
  };
  try {
    await assert.rejects(createStaticExecutionPort({ scratchRoot: root, image }, fake.docker).run(request()),
      /^Error: Static tool execution failed$/);
    assert.deepEqual(fake.calls.map(args => args[0]), ['create', 'inspect', 'rm']);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('captured command and input maps cannot change while scratch setup awaits', async () => {
  const root = await scratch();
  const fake = daemon(async options => {
    const create = fake.calls[0]!;
    const mount = create[create.indexOf('-v') + 1]!;
    const dir = mount.slice(0, -'/work:ro'.length - 1);
    assert.deepEqual(create.slice(create.indexOf(image)), [image, 'oms-sast', '--file', 'src/lib.rs']);
    assert.equal(await readFile(join(dir, 'src/lib.rs'), 'utf8'), 'pub fn handler() {}');
    assert.deepEqual(await readdir(dir), ['src']);
    options.stdout(Buffer.from('{}'));
    return 0;
  });
  try {
    const argv = ['oms-sast', '--file', 'src/lib.rs'];
    const files = new Map([['src/lib.rs', 'pub fn handler() {}']]);
    const pending = createStaticExecutionPort({ scratchRoot: root, image }, fake.docker).run({ ...request(), argv, files });
    argv.splice(0, argv.length, 'sh', '-c', 'unexpected');
    files.clear(); files.set('../escape.rs', 'unexpected');
    assert.equal((await pending).exitCode, 0);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('validated output limits remain fixed if the caller mutates its request during setup', async () => {
  const root = await scratch();
  try {
    for (const stream of ['stdout', 'stderr'] as const) {
      const fake = daemon(async options => {
        options[stream](Buffer.alloc(2048, 120));
        assert.ok(options.signal.aborted, 'original collection budget must stop oversized output');
        return 130;
      });
      const input = request();
      const pending = createStaticExecutionPort({ scratchRoot: root, image }, fake.docker).run(input);
      input.outputBytes = Number.MAX_SAFE_INTEGER;
      const result = await pending;
      assert.equal(result.truncated, true);
      assert.ok(Buffer.byteLength(result.stdout) <= 1024);
      assert.deepEqual(await readdir(root), []);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production discovery matches Anchor, Pinocchio and native syntax fixture goldens offline', { skip }, async () => {
  const { discoverPrograms } = await import('@oms/review');
  const root = await scratch();
  try {
    const port = createStaticExecutionPort({ scratchRoot: root });
    for (const name of ['anchor-vault', 'pinocchio-counter', 'native-counter']) {
      const base = new URL(`../../review/test/fixtures/discovery/${name}`, import.meta.url);
      const result = await discoverPrograms(await captureSnapshot(base.pathname), port);
      assert.deepEqual(result, JSON.parse(await readFile(new URL(base.href + '.golden.json'), 'utf8')));
    }
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Phase A coordinator renders real offline scanner findings without a model or workspace writes', { skip }, async () => {
  const { runPhaseA, parseReviewReport, renderJson, renderMarkdown } = await import('@oms/review');
  const root = await scratch();
  const base = new URL('../../review/test/fixtures/discovery/anchor-vault', import.meta.url);
  const before = await captureSnapshot(base.pathname);
  try {
    const result = await runPhaseA({ snapshot: before,
      scope: { sources: ['src/lib.rs'], manifest: 'Cargo.toml' },
      staticPort: createStaticExecutionPort({ scratchRoot: root }),
      metadata: { reviewId: 'offline-pipeline', createdAt: new Date().toISOString(), repo: { commit: '', dirty: false } },
      toolVersions: { 'oms-sast': '0.1.0', 'cargo-audit': '0.22.2' } });
    assert.equal(result.report.programs[0]?.name, 'anchor-vault');
    assert.equal(result.discovery.issues.length, 0);
    assert.ok(result.report.tools.filter(tool => tool.name === 'oms-sast').every(tool => tool.status === 'ok'));
    assert.ok(result.report.findings.length > 0);
    assert.ok(result.report.findings.every(f => f.label === 'suspected'));
    assert.equal(result.report.model, undefined);
    parseReviewReport(JSON.parse(renderJson(result.report, before.inventory())));
    assert.match(renderMarkdown(result.report, before.inventory()), /Not a professional audit/);
    const after = await captureSnapshot(base.pathname);
    assert.deepEqual(after.inventory(), before.inventory());
    for (const file of before.inventory().keys()) assert.equal(after.read(file), before.read(file));
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production discovery inventories target dependencies without executing cfg or build dependencies', { skip }, async () => {
  const { discoverPrograms } = await import('@oms/review');
  const root = await scratch();
  const source = await scratch();
  try {
    await mkdir(join(source, 'src'));
    await writeFile(join(source, 'src/lib.rs'), 'declare_id!("11111111111111111111111111111111");\npub fn process_instruction() {}\n');
    const port = createStaticExecutionPort({ scratchRoot: root });
    for (const [dependencies, framework] of [
      ["[target.'cfg(target_os = \"solana\")'.dependencies]\na={package='anchor-lang',version='1'}", 'anchor'],
      ["[target.any.dependencies]\npinocchio='0.12'", 'pinocchio'],
      ["[target.any.dependencies]\nsolana-account-info='3'", 'native'],
      ["[target.any.build-dependencies]\nanchor-lang='1'", undefined],
      ["[target.a.dependencies]\nanchor-lang='1'\n[target.b.dependencies]\npinocchio='0.12'", undefined],
    ] as const) {
      await writeFile(join(source, 'Cargo.toml'), `[package]\nname='counter'\n${dependencies}\n`);
      const result = await discoverPrograms(await captureSnapshot(source), port);
      assert.equal(result.programs[0]?.framework, framework);
      assert.equal(result.issues.length, framework ? 0 : 1);
      if (framework) assert.equal(result.programs[0]?.handlers[0]?.name, 'process_instruction');
    }
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});
