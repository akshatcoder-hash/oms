import { acquireSourceAccess, sourceControlDirectory } from '@oms/contract';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { HostRunOptions, SandboxResult } from './exec.ts';
import { hostSandbox, seatbeltArgv } from './seatbelt.ts';

const ALLOWED_ENV = [
  'PATH',
  'HOME',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TMPDIR',
  'SHELL',
  'TERM',
  'SOLANA_RPC_URL',
  'SURFNET_RPC_URL',
  'OMS_OUTPUT_DIR',
];

/** Deliberately construct a fresh environment; never spread the engine environment. */
export function hostEnvironment(
  extra: NodeJS.ProcessEnv = {},
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  // The real HOME holds ~/.config/solana keypairs and cluster config: callers pass a private one.
  // Toolchains live outside it by default, so they are pointed at their real location explicitly.
  const toolchainDefault: Record<string, string | undefined> = {
    CARGO_HOME: inherited.HOME && path.join(inherited.HOME, '.cargo'),
    RUSTUP_HOME: inherited.HOME && path.join(inherited.HOME, '.rustup'),
  };
  for (const name of ALLOWED_ENV) {
    const value = extra[name] ?? (name === 'HOME' ? undefined : (inherited[name] ?? toolchainDefault[name]));
    if (value !== undefined) result[name] = value;
  }
  // Only the caller can name the trusted Surfpool; a shell variable must not open loopback in the Seatbelt profile.
  if (extra.SURFPOOL_BINARY) result.SURFPOOL_BINARY = extra.SURFPOOL_BINARY;
  return result;
}

/** Host argv for one command: under Seatbelt on macOS, unchanged elsewhere. */
export const hostArgv = (
  o: HostRunOptions,
  root: string,
  home: string,
  env: NodeJS.ProcessEnv,
  argv: string[],
): string[] => (hostSandbox() === 'seatbelt' && !o.unsandboxed ? seatbeltArgv(o, root, home, env, argv) : argv);

/** Empty per-execution HOME; the caller removes it when the command exits. */
const createPrivateHome = (): string => mkdtempSync(path.join(tmpdir(), 'oms-home-'));

/** Temporary dependency link lives only under the execution source lease. This is not a read-only mount. */
function hostDependencyLink(o: HostRunOptions): () => void {
  const root = realpathSync(o.mounts.projectMount.hostPath);
  const dependency = o.mounts.readOnlyMounts.find((mount) =>
    ['/work/node_modules', path.join(root, 'node_modules')].includes(mount.containerPath),
  );
  if (!dependency) return () => {};
  const target = path.join(root, 'node_modules');
  let originalMode: number | undefined;
  try {
    const original = lstatSync(target);
    if (!original.isDirectory() || readdirSync(target).length) return () => {};
    originalMode = original.mode & 0o777;
    rmdirSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    symlinkSync(realpathSync(dependency.hostPath), target, 'dir');
  } catch (error) {
    if (originalMode !== undefined) {
      mkdirSync(target, { mode: originalMode });
      chmodSync(target, originalMode);
    }
    throw error;
  }
  const identity = lstatSync(target);
  return () => {
    const current = lstatSync(target);
    if (current.ino !== identity.ino || current.dev !== identity.dev || !current.isSymbolicLink())
      throw new Error('Host dependency link changed; cleanup requires inspection');
    unlinkSync(target);
    if (originalMode !== undefined) {
      mkdirSync(target, { mode: originalMode });
      chmodSync(target, originalMode);
    }
  };
}

const sharedLeases = new Map<string, { count: number; release: () => void }>();

/** One lease for every overlapping run that asked to share it; the file lease is given up when the last one ends. */
function acquireSharedSourceAccess(root: string, control: string, options: HostRunOptions): () => void {
  const key = `${control}\0${root}`;
  const held = sharedLeases.get(key);
  if (held) held.count++;
  else {
    const release = acquireSourceAccess(root, { sourceControlDir: control, kind: 'sandbox' });
    let removeDependency: () => void;
    try {
      removeDependency = hostDependencyLink(options);
    } catch (error) {
      release();
      throw error;
    }
    sharedLeases.set(key, {
      count: 1,
      release: () => {
        removeDependency();
        release();
      },
    });
  }
  let released = false;
  return () => {
    const entry = sharedLeases.get(key);
    if (released || !entry) return;
    released = true;
    if (--entry.count > 0) return;
    sharedLeases.delete(key);
    entry.release();
  };
}

/** Source lease, dependency link and private HOME for one host execution; the returned function releases all three. */
export function acquireHostRun(o: HostRunOptions, root: string): { home: string; cleanup: () => void } {
  const control = sourceControlDirectory(o);
  const release = o.sharedSource
    ? acquireSharedSourceAccess(root, control, o)
    : acquireSourceAccess(root, { sourceControlDir: control, kind: 'sandbox' });
  let removeDependency: () => void;
  try {
    removeDependency = o.sharedSource ? () => {} : hostDependencyLink(o);
  } catch (error) {
    release();
    throw error;
  }
  const home = createPrivateHome();
  return {
    home,
    cleanup() {
      try {
        rmSync(home, { recursive: true, force: true });
        removeDependency();
        release();
      } catch (error) {
        throw new AggregateError([error], 'Host cleanup requires recovery; source ownership retained');
      }
    },
  };
}

/** Seatbelt-confined on macOS; no filesystem or network isolation on Linux. Approval belongs to the tool layer. */
export async function runOnHost(o: HostRunOptions): Promise<SandboxResult> {
  if (!Number.isInteger(o.timeoutMs) || o.timeoutMs <= 0 || o.timeoutMs > 2_147_483_647)
    throw new Error('invalid host timeout');
  if (!o.argv.length || o.argv.some((arg) => typeof arg !== 'string' || arg.includes('\0')))
    throw new Error('invalid host argv');
  const root = realpathSync(o.mounts.projectMount.hostPath);
  const cwd = realpathSync(o.cwd ?? root);
  const rel = path.relative(root, cwd);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw new Error('host cwd must be within task root');
  for (const limit of [o.stdoutLimitBytes, o.stderrLimitBytes]) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
      throw new Error('invalid host output limit');
  }
  o.signal?.throwIfAborted();
  const { home, cleanup } = acquireHostRun(o, root);
  return new Promise<SandboxResult>((resolve, reject) => {
    const env = hostEnvironment({ HOME: o.unsandboxed ? homedir() : home, ...o.env });
    const argv = hostArgv(o, root, home, env, o.argv);
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false,
      cancelled = false,
      truncated = false;
    let failure: unknown;
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let outBytes = 0,
      errBytes = 0;
    const kill = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error;
      }
    };
    const cancel = () => {
      cancelled = true;
      kill();
    };
    o.signal?.addEventListener('abort', cancel, { once: true });
    if (o.signal?.aborted) cancel();
    if (child.pid)
      try {
        o.onSpawn?.(child.pid, cwd);
      } catch (error) {
        failure = error;
        kill();
      }
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs);
    const collect = (chunk: Buffer, target: Buffer[], used: number, limit: number): number => {
      try {
        o.onOutput?.(chunk);
      } catch (error) {
        failure = error;
        kill();
      }
      const take = Math.min(chunk.length, limit - used);
      if (take) target.push(Buffer.from(chunk.subarray(0, take)));
      truncated ||= take < chunk.length;
      return used + take;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes = collect(chunk, stdout, outBytes, o.stdoutLimitBytes ?? 1024 * 1024);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errBytes = collect(chunk, stderr, errBytes, o.stderrLimitBytes ?? 1024 * 1024);
    });
    child.once('error', (error) => {
      failure = error;
    });
    child.once('exit', kill); // Reap descendants even when the shell exits first.
    child.once('close', (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', cancel);
      if (failure) {
        reject(failure);
        return;
      }
      resolve({
        exitCode: timedOut ? 124 : cancelled ? 130 : (code ?? 127),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated,
        timedOut,
        cancelled,
      });
    });
  }).finally(cleanup);
}
