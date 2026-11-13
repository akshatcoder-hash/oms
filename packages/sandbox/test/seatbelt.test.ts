import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { hostEnvironment, hostSandbox, runInSandbox, seatbeltArgv, seatbeltProfile, type RunInSandboxOptions } from '../src/index.ts';
import { skipUnavailable } from '../test-support/infrastructure.ts';

const policy = { home: '/Users/dev', root: '/Users/dev/repos/task', writable: ['/private/tmp/oms-home-1'],
  readable: ['/Users/dev/.cargo'], readOnly: ['/Users/dev/repos/task/tests/pinned.ts', '/Users/dev/repos/task/.git'], surfnetPort: 18899 };

test('seatbelt profile denies key, home and network access and reopens only the worktree, toolchains and Surfnet port', () => {
  const lines = seatbeltProfile(policy).split('\n');
  const at = (rule: string) => { const index = lines.indexOf(rule); assert.notEqual(index, -1, `missing: ${rule}`); return index; };
  const denyHome = at('(deny file-read-data (subpath "/Users/dev"))');
  const allowRead = at('(allow file-read-data file-read* (subpath "/Users/dev/repos/task") (subpath "/Users/dev/.cargo"))');
  at('(allow file-read-data (literal "/Users/dev/repos") (literal "/Users/dev"))');
  const denyKeypair = at('(deny file-read-data file-read* (regex #"-keypair\\.json$") (regex #"/id\\.json$"))');
  const denyKeys = at('(deny file-read-data file-read* ' + ['.ssh', '.config/solana', '.aws', 'Library', '.config/gh', '.docker', '.netrc', '.npmrc'].map(dir => `(subpath "/Users/dev/${dir}")`).join(' ') + ')');
  at('(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc"))');
  const denyWrite = at('(deny file-write* (subpath "/"))');
  const allowWrite = at('(allow file-write* (subpath "/Users/dev/repos/task") (subpath "/private/tmp/oms-home-1"))');
  const pinned = at('(deny file-write* (literal "/Users/dev/repos/task/tests/pinned.ts") (subpath "/Users/dev/repos/task/tests/pinned.ts") (literal "/Users/dev/repos/task/.git") (subpath "/Users/dev/repos/task/.git"))');
  const denyNet = at('(deny network*)');
  const allowNet = at('(allow network-outbound (remote ip "localhost:18899"))');
  // SBPL: the last matching rule wins.
  assert.ok(denyHome < allowRead && allowRead < denyKeypair && denyKeypair < denyKeys && denyWrite < allowWrite && allowWrite < pinned && denyNet < allowNet);
  assert.equal(lines.filter(line => line.startsWith('(allow network')).length, 1);
});

test('seatbelt profile without a Surfnet port allows no network and quotes paths safely', () => {
  const profile = seatbeltProfile({ ...policy, surfnetPort: undefined, root: '/Users/dev/a "b"\\c', readOnly: [] });
  assert.doesNotMatch(profile, /allow network/);
  assert.match(profile, /\(subpath "\/Users\/dev\/a \\"b\\"\\\\c"\)/);
  assert.throws(() => seatbeltProfile({ ...policy, root: '/Users/dev/x\n(allow default)' }), /control character/);
});

test('seatbelt profile opens loopback only for a trusted Surfpool, which only the caller can name', () => {
  assert.doesNotMatch(seatbeltProfile(policy), /network-bind|network-inbound|localhost:\*/);
  const profile = seatbeltProfile({ ...policy, surfpool: '/Users/dev/.oms/tools/surfpool' });
  assert.match(profile, /\(allow network-bind network-inbound \(local ip "localhost:\*"\)\)/);
  for (const port of [8899, 8900, 9900]) assert.match(profile, new RegExp(`\\(allow network-outbound \\(remote ip "localhost:${port}"\\)\\)`));
  assert.doesNotMatch(profile, /network-outbound \(remote ip "localhost:\*"\)/, 'outbound loopback stays limited to the Solana ports');
  assert.equal(hostEnvironment({}, { SURFPOOL_BINARY: '/inherited/surfpool' }).SURFPOOL_BINARY, undefined);
  assert.equal(hostEnvironment({ SURFPOOL_BINARY: '/trusted/surfpool' }, { SURFPOOL_BINARY: '/inherited/surfpool' }).SURFPOOL_BINARY, '/trusted/surfpool');
});

test('host sandbox is Seatbelt only on darwin with sandbox-exec', () => {
  assert.equal(hostSandbox('darwin', () => true), 'seatbelt');
  assert.equal(hostSandbox('darwin', () => false), 'none');
  assert.equal(hostSandbox('linux', () => true), 'none');
});

test('seatbelt reads: a PATH entry never opens its parent, and a linked worktree can read its git dirs', () => {
  const home = realpathSync(homedir());
  const base = mkdtempSync(path.join(tmpdir(), 'oms-sb-'));
  const root = path.join(base, 'task');
  const gitdir = path.join(base, 'main', '.git', 'worktrees', 'task');
  mkdirSync(gitdir, { recursive: true });
  mkdirSync(root);
  writeFileSync(path.join(root, '.git'), `gitdir: ${gitdir}\n`);
  writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
  try {
    const argv = seatbeltArgv(fixture(root, []), realpathSync(root), base, { PATH: `${home}/Library/pnpm:/usr/bin` }, ['true']);
    const reads = readFileSync(argv[2]!, 'utf8').split('\n').find(line => line.startsWith('(allow file-read-data file-read*'))!;
    assert.match(reads, new RegExp(`\\(subpath "${home}/Library/pnpm"\\)`));
    assert.doesNotMatch(reads, new RegExp(`\\(subpath "${home}/Library"\\)`));
    assert.doesNotMatch(reads, /\(subpath "\/usr"\)/);
    for (const dir of [gitdir, path.join(base, 'main', '.git')]) assert.ok(reads.includes(`(subpath "${realpathSync(dir)}")`), `${dir} not readable`);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

const SECRETS = { XAI_API_KEY: 'x', TINYFISH_API_KEY: 't', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', OMS_KNOWLEDGE_TOKEN: 'k',
  AWS_ACCESS_KEY_ID: 'id', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 'st', AWS_PROFILE: 'p', NODE_OPTIONS: '--require=/x' };

function fixture(root: string, argv: string[]): RunInSandboxOptions {
  return { backend: 'host', taskName: 'seatbelt', phase: 'run', argv, timeoutMs: 10_000, image: '', forwarderImage: '', leaseDir: root,
    mounts: { projectMount: { hostPath: root, containerPath: root, mode: 'rw' }, extraMounts: [], readOnlyMounts: [], volumes: [], shadowMounts: [] } };
}

test('no credential variable reaches a host child, from the engine env or from the caller', async () => {
  assert.deepEqual(Object.keys(hostEnvironment(SECRETS, { ...SECRETS, PATH: '/bin', LC_CTYPE: 'UTF-8' })).sort(), ['LC_CTYPE', 'PATH']);
  const root = mkdtempSync(path.join(tmpdir(), 'oms-env-'));
  const saved = { ...process.env };
  Object.assign(process.env, SECRETS);
  try {
    const o = { ...fixture(root, [process.execPath, '-e', 'console.log(JSON.stringify(process.env))']), env: SECRETS };
    const result = await runInSandbox(o);
    assert.equal(result.exitCode, 0, result.stderr);
    const leaked = Object.keys(JSON.parse(result.stdout)).filter(name => name in SECRETS || name.startsWith('AWS_'));
    assert.deepEqual(leaked, []);
  } finally {
    for (const name of Object.keys(SECRETS)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});

// darwin only: each prototype block, proven by a real child under sandbox-exec. scripts/seatbelt-verify.sh runs these.
const darwin = { skip: hostSandbox() !== 'seatbelt' && 'needs macOS sandbox-exec' };

async function sandboxed(script: string, extra: Partial<RunInSandboxOptions> = {}) {
  const base = mkdtempSync(path.join(homedir(), '.oms-seatbelt-probe-'));
  const root = path.join(base, 'task');
  mkdirSync(root);
  try {
    return { base, result: await runInSandbox({ ...fixture(root, ['/bin/sh', '-c', script]), ...extra, mounts: fixture(root, []).mounts }) };
  } finally { rmSync(base, { recursive: true, force: true }); }
}

/** A probe file the host can read, removed afterwards; `dir` is created if absent and removed only if this created it. */
function probe(dir: string, name: string): { file: string; remove(): void } {
  const existed = (() => { try { return realpathSync(dir); } catch { return undefined; } })();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${name}-${process.pid}`);
  writeFileSync(file, 'probe');
  assert.equal(readFileSync(file, 'utf8'), 'probe');
  return { file, remove() { rmSync(file, { force: true }); if (!existed) rmSync(dir, { recursive: true, force: true }); } };
}

const blocked = (result: { exitCode: number; stdout: string }) => assert.notEqual(result.exitCode, 0, result.stdout);

test('seatbelt: worktree reads and writes still work', darwin, async () => {
  const { result } = await sandboxed(`echo ok > file && cat file && '${process.execPath}' -e 0`);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /ok/);
});

test('seatbelt: keypair read is blocked', darwin, async () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'oms-keypair-'));
  const key = path.join(outside, 'deployer-keypair.json');
  writeFileSync(key, '[1,2,3]');
  try { blocked((await sandboxed(`cat '${key}'`)).result); } finally { rmSync(outside, { recursive: true, force: true }); }
});

test('seatbelt: keypair inside the worktree is still blocked', darwin, async () => {
  blocked((await sandboxed(`echo '[1]' > deployer-keypair.json && cat deployer-keypair.json`)).result);
});

test('seatbelt: ~/.ssh read is blocked', darwin, async () => {
  const p = probe(path.join(homedir(), '.ssh'), 'oms-seatbelt-probe');
  try { blocked((await sandboxed(`cat '${p.file}'`)).result); } finally { p.remove(); }
});

test('seatbelt: ~/.config/solana read is blocked', darwin, async () => {
  const p = probe(path.join(homedir(), '.config', 'solana'), 'oms-seatbelt-probe');
  try { blocked((await sandboxed(`cat '${p.file}'`)).result); } finally { p.remove(); }
});

test('seatbelt: other-repo read is blocked', darwin, async () => {
  const other = mkdtempSync(path.join(homedir(), '.oms-seatbelt-other-'));
  writeFileSync(path.join(other, 'secret.txt'), 'other repo');
  try { blocked((await sandboxed(`cat '${other}/secret.txt'`)).result); } finally { rmSync(other, { recursive: true, force: true }); }
});

test('seatbelt: write outside the worktree is blocked', darwin, async () => {
  const target = path.join(homedir(), `.oms-seatbelt-outside-${process.pid}`);
  try {
    blocked((await sandboxed(`echo x > '${target}'`)).result);
    assert.throws(() => readFileSync(target));
  } finally { rmSync(target, { force: true }); }
});

test('seatbelt: write to a pinned verifier file is blocked', darwin, async () => {
  const base = mkdtempSync(path.join(homedir(), '.oms-seatbelt-probe-'));
  const root = path.join(base, 'task');
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  const pinned = path.join(root, 'tests', 'pinned.test.ts');
  writeFileSync(pinned, 'pinned');
  try {
    const result = await runInSandbox({ ...fixture(root, ['/bin/sh', '-c', `echo free > free.txt; echo changed > '${pinned}'`]), protectedPaths: [pinned] });
    assert.equal(readFileSync(pinned, 'utf8'), 'pinned');
    assert.equal(readFileSync(path.join(root, 'free.txt'), 'utf8'), 'free\n');
    assert.notEqual(result.exitCode, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('seatbelt: keychain access is blocked', darwin, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oms-keychain-'));
  const keychain = path.join(dir, 'probe.keychain');
  const security = (...args: string[]) => `/usr/bin/security ${args.map(arg => `'${arg}'`).join(' ')}`;
  const { execSync } = await import('node:child_process');
  execSync(`${security('create-keychain', '-p', 'probe', keychain)} && ${security('add-generic-password', '-s', 'oms-probe', '-a', 'oms', '-w', 'secret', keychain)}`);
  try {
    assert.equal(execSync(security('find-generic-password', '-s', 'oms-probe', '-w', keychain), { encoding: 'utf8' }).trim(), 'secret');
    const { result } = await sandboxed(security('find-generic-password', '-s', 'oms-probe', '-w', keychain));
    assert.doesNotMatch(result.stdout, /secret/);
    blocked(result);
  } finally { execSync(security('delete-keychain', keychain)); rmSync(dir, { recursive: true, force: true }); }
});

test('seatbelt: outbound network other than the Surfnet port is blocked', darwin, async () => {
  const servers = await Promise.all([0, 0].map(() => new Promise<net.Server>(resolve => {
    const server = net.createServer(socket => socket.end('pong'));
    server.listen(0, '127.0.0.1', () => resolve(server));
  })));
  const [surfnet, other] = servers.map(server => (server.address() as net.AddressInfo).port);
  const connect = (host: string, port: number) => `'${process.execPath}' -e "const s=require('net').connect(${port},'${host}');s.on('data',()=>process.exit(0));s.on('error',()=>process.exit(3));setTimeout(()=>process.exit(4),3000)"`;
  try {
    const allowed = (await sandboxed(connect('127.0.0.1', surfnet!), { surfnet: { port: surfnet! } })).result;
    assert.equal(allowed.exitCode, 0, `Surfnet port must stay reachable: ${allowed.stderr}`);
    blocked((await sandboxed(connect('127.0.0.1', other!), { surfnet: { port: surfnet! } })).result);
    blocked((await sandboxed(connect('1.1.1.1', 443), { surfnet: { port: surfnet! } })).result);
  } finally { for (const server of servers) server.close(); }
});

test('seatbelt: a command can start the trusted Surfpool on the standard port and reach it, but not other local services', darwin, async t => {
  const binary = process.env.SURFPOOL_BINARY;
  if (await skipUnavailable(t, { surfpool: binary }) || !binary) return;
  const tools = mkdtempSync(path.join(homedir(), '.oms-seatbelt-surfpool-'));
  const trusted = path.join(tools, 'surfpool');
  copyFileSync(realpathSync(binary), trusted);
  const port = 8899;
  const busy = await new Promise<boolean>(resolve => {
    const probe = net.createServer().once('error', () => resolve(true)).listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
  });
  if (busy) { t.skip('127.0.0.1:8899 is in use on this machine'); return; }
  const other = net.createServer().listen(0, '127.0.0.1');
  await once(other, 'listening');
  const otherPort = (other.address() as net.AddressInfo).port;
  const script = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.env.SURFPOOL_BINARY, ['start', '--ci', '--no-tui', '--offline', '--port', '${port}', '--ws-port', '${port + 1}', '--airdrop-amount', '0'], { stdio: 'ignore' });
    child.on('error', error => process.stdout.write(error.message, () => process.exit(2)));
    (async () => {
      for (let attempt = 0; attempt < 120; attempt++) {
        try {
          const response = await fetch('http://127.0.0.1:${port}', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }) });
          if ((await response.json()).result === 'ok') {
            child.kill('SIGKILL');
            const reached = await new Promise(done => { const socket = require('node:net').connect(${otherPort}, '127.0.0.1');
              socket.once('connect', () => { socket.destroy(); done(true); }); socket.once('error', () => done(false)); });
            process.stdout.write(reached ? 'HEALTHY OTHER-REACHED' : 'HEALTHY OTHER-BLOCKED', () => process.exit(0)); return;
          }
        } catch {}
        await new Promise(done => setTimeout(done, 250));
      }
      child.kill('SIGKILL'); process.stdout.write('never healthy', () => process.exit(3));
    })();`;
  try {
    const { result } = await sandboxed(`cat > probe.js <<'SCRIPT'\n${script}\nSCRIPT\n'${process.execPath}' -e "$(cat probe.js)"`, { env: { SURFPOOL_BINARY: trusted } });
    assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /HEALTHY/);
    assert.match(result.stdout, /OTHER-BLOCKED/, 'another local service stays unreachable');
  } finally { other.close(); rmSync(tools, { recursive: true, force: true }); }
});
