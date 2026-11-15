/**
 * Integration tests against the real Docker daemon (Colima). Every test skips
 * cleanly when `docker info` fails.
 *
 * Proven here, on the daemon:
 *  1. the token/signer dir is unreadable from both phases unless mounted, and
 *     the mount builder refuses to mount it (unit-tested separately);
 *  2. run phase: arbitrary external IP and a second local server are
 *     unreachable, the surfnet-port stand-in is reachable;
 *  3. install phase: the allowlisted fake registry works through the proxy
 *     (GET and CONNECT), a non-allowlisted port is refused with 403;
 *  4. readOnlyPaths cannot be written from inside;
 *  5. timeout kills and removes the container;
 *  6. no oms- leftovers afterwards.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { dockerInfoWorks, removeScratchDir, dockerOut } from '../src/docker.ts';
import { buildMounts } from '../src/mounts.ts';
import { removeTaskResources, hasLeftovers } from '../src/cleanup.ts';
import { runInSandbox, type DockerRunOptions } from '../src/exec.ts';
import type { AddressInfo } from 'node:net';
import { digestCodeInputs, EMPTY_SNAPSHOT_DIGEST, saveCodeInputs } from '@oms/contract';
import { skipUnavailable } from '../test-support/infrastructure.ts';

const TASK = `sbxitest-${process.pid}`;
const IMAGE = process.env.OMS_SANDBOX_IMAGE;
const FORWARDER_IMAGE = process.env.OMS_SANDBOX_FORWARDER_IMAGE;

interface Fixture {
  base: string;
  project: string;
  signerDir: string;
  stateDir: string;
  tokenFile: string;
  innerSigner: string;
  verifyDir: string;
  servers: http.Server[];
  registryPort: number;
  secondPort: number;
  surfnetPort: number;
}

let fixture: Fixture | null = null;
let dockerUp: boolean | null = null;

async function daemon(): Promise<boolean> {
  if (!IMAGE || !FORWARDER_IMAGE) return false;
  if (dockerUp === null) dockerUp = await dockerInfoWorks();
  return dockerUp;
}

function startServer(reply: string): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.end(reply);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function makeScratchDirMounted(prefix: string): string {
  // Colima only shares $HOME (and its configured mounts) into the VM, so
  // os.tmpdir() (/var/folders/...) is invisible inside containers. The brief
  // designates packages/<name>/.tmp/ as scratch space; it lives under $HOME.
  const root = path.join(import.meta.dirname, '..', '.tmp');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(path.join(root, prefix));
}

async function makeFixture(): Promise<Fixture> {
  if (fixture) return fixture;
  const base = makeScratchDirMounted('int-');
  const project = path.join(base, 'project');
  const signerDir = path.join(base, 'signerdir');
  const stateDir = path.join(base, 'oms-state');
  mkdirSync(project, { recursive: true });
  mkdirSync(signerDir, { mode: 0o700 });
  mkdirSync(stateDir, { mode: 0o700 });
  const tokenFile = path.join(signerDir, 'channel.token');
  writeFileSync(tokenFile, 'FAKE-TOKEN-NOT-REAL\n', { mode: 0o600 });
  const innerSigner = path.join(project, '.oms-signer');
  mkdirSync(innerSigner, { mode: 0o700 });
  writeFileSync(path.join(innerSigner, 'tui.token'), 'SHADOW-TOKEN\n', { mode: 0o600 });
  const verifyDir = path.join(project, '.oms', 'verify');
  mkdirSync(verifyDir, { recursive: true });
  writeFileSync(path.join(verifyDir, 'verifier.test.ts'), 'assert.ok(true);\n');
  writeFileSync(path.join(project, 'a.txt'), 'hello\n');
  const registry = await startServer('REGISTRY-OK\n');
  const second = await startServer('SECOND-OK\n');
  const surfnet = await startServer('SURFNET-OK\n');
  fixture = {
    base,
    project,
    signerDir,
    stateDir,
    tokenFile,
    innerSigner,
    verifyDir,
    servers: [registry.server, second.server, surfnet.server],
    registryPort: registry.port,
    secondPort: second.port,
    surfnetPort: surfnet.port,
  };
  return fixture;
}

function mounts(f: Fixture) {
  // Mirrors the real layout: the signer socket lives inside the project
  // (<project>/.oms-signer) and must be shadowed; the outer signer/token dir
  // must never be mounted at all.
  return buildMounts({
    projectRoot: f.project,
    taskName: TASK,
    forbidden: { signerDir: f.innerSigner, stateDir: f.stateDir, extra: [f.signerDir] },
    readOnlyPaths: [f.verifyDir],
  });
}

function run(f: Fixture, over: Partial<DockerRunOptions>): Promise<import('../src/exec.ts').SandboxResult> {
  return runInSandbox({
    backend: 'docker',
    taskName: TASK,
    phase: 'run',
    argv: ['sh', '-c', 'true'],
    mounts: over.mounts ?? mounts(f),
    timeoutMs: 120_000,
    image: IMAGE!,
    forwarderImage: FORWARDER_IMAGE!,
    leaseDir: path.join(f.base, 'leases'),
    sourceControlDir: path.join(f.base, 'source-control'),
    surfnet: { port: f.surfnetPort },
    ...over,
  });
}

before(async () => {
  if (await daemon()) await removeTaskResources(TASK);
});

// A name-filtered run skips the final cleanup test; open fixture servers would keep the process alive.
after(() => {
  for (const server of fixture?.servers ?? []) server.close();
  if (fixture) removeScratchDir(fixture.base);
  fixture = null;
});

test('token/signer dir is unreadable from the run phase; shadowed inner dir too', async (t) => {
  if (await skipUnavailable(t, { docker: [IMAGE, FORWARDER_IMAGE] })) return;
  const f = await makeFixture();
  const r = await run(f, {
    argv: [
      'sh',
      '-c',
      [
        `cat ${f.tokenFile}`,
        'cat /work/../signerdir/channel.token',
        'ls /work/.oms-signer/',
        'cat /work/.oms-signer/tui.token',
      ].join('; '),
    ],
  });
  assert.equal(r.exitCode, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.ok(!r.stdout.includes('FAKE-TOKEN'), 'outer signer token leaked');
  assert.ok(!r.stdout.includes('SHADOW-TOKEN'), 'inner (shadowed) signer token leaked');
  assert.ok(!r.stdout.includes('tui.token'), 'shadow tmpfs did not hide the inner signer dir');
});

test('token/signer dir is unreadable from the install phase', async (t) => {
  if (await skipUnavailable(t, { docker: [IMAGE, FORWARDER_IMAGE] })) return;
  const f = await makeFixture();
  const r = await run(f, {
    phase: 'install',
    installAllowlist: [`host.docker.internal:${f.registryPort}`],
    argv: ['sh', '-c', `cat ${f.tokenFile}; cat /work/../signerdir/channel.token`],
  });
  assert.equal(r.exitCode, 1);
  assert.ok(!r.stdout.includes('FAKE-TOKEN'), 'signer token leaked in install phase');
});

test('run phase: surfnet stand-in reachable, second local server and external IP are not', async (t) => {
  if (await skipUnavailable(t, { docker: [IMAGE, FORWARDER_IMAGE] })) return;
  const f = await makeFixture();
  const script = `
    const checks = [
      ['surfnet', 'http://host.docker.internal:${f.surfnetPort}/'],
      ['secondServer', 'http://host.docker.internal:${f.secondPort}/'],
      ['hostDirect', 'http://192.168.5.2:${f.surfnetPort}/'],
      ['external', 'http://1.1.1.1/'],
    ];
    const out = {};
    for (const [k, u] of checks) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(5000) });
        out[k] = 'status:' + r.status + ':' + (await r.text()).trim().slice(0, 60);
      } catch (e) {
        out[k] = 'blocked:' + (e.cause?.code ?? e.name);
      }
    }
    console.log('RESULT' + JSON.stringify(out));
  `;
  const r = await run(f, { argv: ['node', '-e', script] });
  assert.equal(r.exitCode, 0, `stderr=${r.stderr}`);
  const m = r.stdout.match(/RESULT(\{.*\})/);
  assert.ok(m, `no result line in stdout: ${r.stdout}`);
  const out = JSON.parse(m?.[1] ?? '{}') as Record<string, string>;
  assert.ok(out['surfnet']?.includes('SURFNET-OK'), `surfnet stand-in must be reachable: ${out['surfnet']}`);
  assert.ok(out['secondServer']?.startsWith('blocked:'), `second local server must be unreachable: ${out['secondServer']}`);
  assert.ok(out['hostDirect']?.startsWith('blocked:'), `direct host address must be unreachable: ${out['hostDirect']}`);
  assert.ok(out['external']?.startsWith('blocked:'), `external IP must be unreachable: ${out['external']}`);
});

test('install phase: allowlisted fake registry works via proxy (GET+CONNECT), other port refused', async (t) => {
  if (await skipUnavailable(t, { docker: [IMAGE, FORWARDER_IMAGE] })) return;
  const f = await makeFixture();
  const script = `
    const http = require('node:http');
    const PROXY = { host: 'oms-fwd', port: 3128 };
    function get(abs) {
      return new Promise((res) => {
        const u = new URL(abs);
        const rq = http.request(
          { host: PROXY.host, port: PROXY.port, method: 'GET', path: abs, headers: { host: u.host } },
          (rs) => {
            let b = '';
            rs.on('data', (c) => (b += c));
            rs.on('end', () => res({ status: rs.statusCode, body: b.trim() }));
          },
        );
        rq.on('error', (e) => res({ error: e.code ?? e.message }));
        rq.end();
      });
    }
    function connect(hp) {
      return new Promise((res) => {
        const rq = http.request({ host: PROXY.host, port: PROXY.port, method: 'CONNECT', path: hp });
        rq.on('connect', (rs, sock) => {
          if (rs.statusCode !== 200) {
            sock.destroy();
            res({ status: rs.statusCode });
            return;
          }
          sock.write('GET / HTTP/1.0\\r\\n\\r\\n');
          let b = '';
          sock.on('data', (c) => (b += c));
          sock.on('end', () => res({ status: rs.statusCode, body: b.trim() }));
          sock.on('error', () => res({ status: rs.statusCode, body: b.trim() }));
        });
        rq.on('error', (e) => res({ error: e.code ?? e.message }));
        rq.end();
      });
    }
    (async () => {
      const out = {
        getOk: await get('http://host.docker.internal:${f.registryPort}/'),
        getDenied: await get('http://host.docker.internal:${f.secondPort}/'),
        connectOk: await connect('host.docker.internal:${f.registryPort}'),
        connectDenied: await connect('host.docker.internal:${f.secondPort}'),
      };
      console.log('RESULT' + JSON.stringify(out));
    })();
  `;
  const r = await run(f, {
    phase: 'install',
    installAllowlist: [`host.docker.internal:${f.registryPort}`],
    argv: ['node', '-e', script],
  });
  assert.equal(r.exitCode, 0, `stderr=${r.stderr}`);
  const m = r.stdout.match(/RESULT(\{.*\})/);
  assert.ok(m, `no result line in stdout: ${r.stdout}`);
  const out = JSON.parse(m?.[1] ?? '{}') as Record<string, { status?: number; body?: string; error?: string }>;
  assert.ok(out['getOk']?.body === 'REGISTRY-OK', `allowlisted GET must relay: ${JSON.stringify(out['getOk'])}`);
  assert.ok(out['connectOk']?.body?.includes('REGISTRY-OK'), `allowlisted CONNECT must relay: ${JSON.stringify(out['connectOk'])}`);
  assert.equal(out['getDenied']?.status, 403, `non-allowlisted GET must be refused: ${JSON.stringify(out['getDenied'])}`);
  assert.equal(out['connectDenied']?.status, 403, `non-allowlisted CONNECT must be refused: ${JSON.stringify(out['connectDenied'])}`);
});

test('readOnlyPaths cannot be written from inside; project writes still work', async (t) => {
  if (await skipUnavailable(t, { docker: [IMAGE, FORWARDER_IMAGE] })) return;
  const f = await makeFixture();
  const before = statSync(f.project);
  const r = await run(f, {
    argv: [
      'sh',
      '-c',
      'echo hi > /work/written.txt && cat /work/written.txt && (echo evil > /work/.oms/verify/evil.ts)',
    ],
  });
  assert.equal(r.exitCode, 1, `stderr=${r.stderr}`);
  assert.ok(r.stdout.includes('hi'), 'project rw write failed unexpectedly');
  assert.ok(/Read-only/i.test(r.stderr), `readOnly write must fail with EROFS: ${r.stderr}`);
  const written = statSync(path.join(f.project, 'written.txt'));
  assert.equal(written.uid, process.getuid!(), 'sandbox writes must preserve trusted host user ownership');
  assert.equal(statSync(f.project).mode, before.mode, 'worktree permissions must not be widened');
});

test('host env is not inherited and output caps truncate', async (t) => {
  if (await skipUnavailable(t, { docker: [IMAGE, FORWARDER_IMAGE] })) return;
  const f = await makeFixture();
  process.env.OMS_SANDBOX_LEAK_PROBE = 'leak-probe-value';
  const r = await run(f, {
    argv: ['sh', '-c', 'env; head -c 200000 /dev/zero | tr "\\0" "x"'],
    stdoutLimitBytes: 1000,
  });
  delete process.env.OMS_SANDBOX_LEAK_PROBE;
  assert.ok(!r.stdout.includes('leak-probe-value'), 'host env leaked into the container');
  assert.equal(r.truncated, true, 'output cap must mark truncation');
  assert.ok(r.stdout.length <= 1024 * 1024);
});

test('owned volume sentinel survives install and repeated run calls', async (t) => {
  if (await skipUnavailable(t, { docker: [IMAGE, FORWARDER_IMAGE] })) return;
  const f = await makeFixture();
  const install = await run(f, {
    phase: 'install',
    installAllowlist: [`host.docker.internal:${f.registryPort}`],
    argv: ['sh', '-c', 'printf persistent > /work/node_modules/oms-sentinel'],
  });
  assert.equal(install.exitCode, 0, install.stderr);
  const mutation = await run(f, { argv: ['sh', '-c', 'printf changed > /work/node_modules/oms-sentinel'] });
  assert.notEqual(mutation.exitCode, 0, 'run consumers must not mutate shared dependencies');
  assert.match(mutation.stderr, /Read-only/i);
  for (let i = 0; i < 2; i++) {
    const result = await run(f, { argv: ['cat', '/work/node_modules/oms-sentinel'] });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, 'persistent');
  }
});

test('aborting one overlapping run does not tear down its live peer', async (t) => {
  if (await skipUnavailable(t, { docker: [IMAGE, FORWARDER_IMAGE] })) return;
  const f = await makeFixture();
  let firstReady!: (response: http.ServerResponse) => void;
  let secondReady!: (response: http.ServerResponse) => void;
  const first = new Promise<http.ServerResponse>(resolve => { firstReady = resolve; });
  const second = new Promise<http.ServerResponse>(resolve => { secondReady = resolve; });
  const server = http.createServer((req, res) => {
    (req.url === '/first' ? firstReady : secondReady)(res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as AddressInfo).port;
  const controller = new AbortController();
  const command = (name: string) => ['node', '-e', `fetch('http://host.docker.internal:${port}/${name}').then(r => r.text()).then(console.log)`];
  const peerRoot = path.join(f.base, 'peer-project');
  mkdirSync(peerRoot);
  const peerMounts = buildMounts({ projectRoot: peerRoot, taskName: TASK, forbidden: { signerDir: f.signerDir, stateDir: f.stateDir } });
  const slow = run(f, { surfnet: { port }, argv: command('first') });
  const firstResponse = await first;
  const stopped = run(f, { mounts: peerMounts, surfnet: { port }, argv: command('second'), signal: controller.signal });
  await second;
  controller.abort();
  assert.equal((await stopped).cancelled, true);
  firstResponse.end('still alive');
  const result = await slow;
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /still alive/);
});

test('timeout kills and removes the container', async (t) => {
  if (await skipUnavailable(t, { docker: [IMAGE, FORWARDER_IMAGE] })) return;
  const f = await makeFixture();
  const r = await run(f, { argv: ['sh', '-c', 'sleep 30'], timeoutMs: 2500 });
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, 124);
  const ps = await dockerOut(['ps', '-a', '--filter', `label=oms.task=${TASK}`, '--format', '{{.Names}}']);
  assert.equal(ps.trim(), '', 'container must be removed after timeout');
});

test('real sandbox writer excludes host input capture through fully awaited teardown', async t => {
  if (await skipUnavailable(t, { docker: [IMAGE, FORWARDER_IMAGE] })) return;
  const f = await makeFixture();
  const server = http.createServer();
  const request = once(server, 'request');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as AddressInfo).port;
  const options = { sourceControlDir: path.join(f.base, 'source-control') };
  const config = { schema: 'oms.evaluator/0' as const, codePaths: [], snapshotDigest: EMPTY_SNAPSHOT_DIGEST, executionIdentity: 'test:real-writer' };
  const running = run(f, { surfnet: { port }, argv: ['node', '-e',
    `require('node:fs').writeFileSync('/work/live-source.txt', 'writer-active'); fetch('http://host.docker.internal:${port}/').then(r => r.text())`,
  ] });
  const [, response] = await request as [http.IncomingMessage, http.ServerResponse];
  try {
    assert.throws(() => saveCodeInputs(f.project, config, options), { code: 'E_SOURCE_BUSY' });
    assert.throws(() => digestCodeInputs(f.project, config, options), { code: 'E_SOURCE_BUSY' });
  } finally { response.end('finish'); await running; }
  const saved = saveCodeInputs(f.project, config, options);
  saved.dispose();
});

test('real permitted writer cannot substitute a later approved readonly overlay bind', async t => {
  if (await skipUnavailable(t, { docker: [IMAGE, FORWARDER_IMAGE] })) return;
  const f = await makeFixture();
  const approved = mounts(f);
  const mutable = buildMounts({
    projectRoot: f.project, taskName: TASK,
    forbidden: { signerDir: f.innerSigner, stateDir: f.stateDir, extra: [f.signerDir] },
  });
  try {
    const result = await run(f, { mounts: mutable, argv: ['sh', '-c',
      `mv /work/.oms /work/.oms-before && ln -s ${JSON.stringify(f.signerDir)} /work/.oms`,
    ] });
    assert.equal(result.exitCode, 0, result.stderr);
    await assert.rejects(run(f, { mounts: approved, argv: ['cat', '/work/.oms/verify/channel.token'] }), { code: 'E_MOUNT_FORBIDDEN' });
  } finally {
    if (existsSync(path.join(f.project, '.oms-before'))) {
      rmSync(path.join(f.project, '.oms'), { recursive: true, force: true });
      renameSync(path.join(f.project, '.oms-before'), path.join(f.project, '.oms'));
    }
  }
});

test('cleanup: no oms- leftovers in containers, networks or volumes', async (t) => {
  if (await skipUnavailable(t, { docker: [IMAGE, FORWARDER_IMAGE] })) return;
  const f = await makeFixture();
  // runInSandbox tears its temp network and forwarder down itself; verify that
  // first, then prove removeTaskResources also finds labeled strays.
  await run(f, { argv: ['sh', '-c', 'true'] });
  // Containers and networks are auto-torn-down per call; heavy-dir volumes
  // persist by design until task cleanup.
  const afterRun = await hasLeftovers(TASK);
  assert.deepEqual(
    afterRun.detail.filter(
      (d) => !d.startsWith(`oms-${TASK}-node_modules`) && !d.startsWith(`oms-${TASK}-target`),
    ),
    [],
    `after run: ${JSON.stringify(afterRun.detail)}`,
  );
  await dockerOut(['network', 'create', '--internal', '--label', 'oms.component=sandbox', '--label', `oms.task=${TASK}`, `oms-${TASK}-stray-net`]);
  await dockerOut(['volume', 'create', '--label', 'oms.component=sandbox', '--label', `oms.task=${TASK}`, `oms-${TASK}-stray-vol`]);
  const cleaned = await removeTaskResources(TASK);
  assert.ok(
    cleaned.networks.includes(`oms-${TASK}-stray-net`),
    `network removed: ${JSON.stringify(cleaned)}`,
  );
  assert.ok(
    cleaned.volumes.includes(`oms-${TASK}-stray-vol`) &&
      cleaned.volumes.includes(`oms-${TASK}-node_modules`),
    `volume removed: ${JSON.stringify(cleaned)}`,
  );
  const left = await hasLeftovers(TASK);
  assert.equal(left.leftovers, false, `leftovers: ${JSON.stringify(left.detail)}`);
  for (const f2 of fixture?.servers ?? []) f2.close();
  removeScratchDir(f.base);
  fixture = null;
});
