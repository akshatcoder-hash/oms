/**
 * macOS Seatbelt (sandbox-exec) profile for host-mode commands.
 * Later SBPL rules override earlier ones, so each block narrows or reopens the one before it.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { HostRunOptions } from './exec.ts';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Host mode isolates commands only where Seatbelt exists; Linux v0.1 runs them unsandboxed. */
export const hostSandbox = (platform = process.platform, exists = existsSync): 'seatbelt' | 'none' =>
  platform === 'darwin' && exists(SANDBOX_EXEC) ? 'seatbelt' : 'none';

export interface SeatbeltPolicy {
  /** Real user home: file contents under it are unreadable except `readable` and `root`. */
  home: string;
  /** Task worktree: readable and writable. */
  root: string;
  /** Extra writable trees besides root (private HOME, temp, verifier output, cargo caches). */
  writable: string[];
  /** Toolchain and dependency trees under `home` that commands must read. */
  readable: string[];
  /** Pinned verifier files and git control: never writable, even inside root. */
  readOnly: string[];
  /** The only network destination: 127.0.0.1:<port>. */
  surfnetPort?: number;
  /** Trusted Surfpool binary: readable, and commands may start it on loopback and reach it on the standard local Solana ports. */
  surfpool?: string;
}

/** solana-test-validator and Surfpool defaults: JSON-RPC, its websocket, and the faucet. */
export const SOLANA_LOCAL_PORTS = [8899, 8900, 9900] as const;

const quote = (value: string): string => {
  if (/[\0\n\r]/.test(value)) throw new Error('seatbelt path contains a control character');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
};
/** Credential stores under home: unreadable even when a toolchain root contains them. */
const SECRET_DIRS = ['.ssh', '.config/solana', '.aws', 'Library', '.config/gh', '.docker', '.netrc', '.npmrc'];
const subpaths = (paths: readonly string[]) => paths.map(p => `(subpath ${quote(p)})`).join(' ');
/** Directories from home (inclusive) down to root's parent: only their listings are reopened. */
const ancestors = (root: string, home: string): string[] => {
  const out: string[] = [];
  for (let dir = path.dirname(root); dir.startsWith(home) && dir.length >= home.length; dir = path.dirname(dir)) { out.push(dir); if (dir === home) break; }
  return out;
};

export function seatbeltProfile(policy: SeatbeltPolicy): string {
  const { home } = policy;
  const rules = [
    '(version 1)',
    '(allow default)',
    ';; Reads: nothing under the real home except the worktree and toolchains; never keys or other repos.',
    `(deny file-read-data (subpath ${quote(home)}))`,
    // macOS 26 ranks an operation-specific rule above a file-read* wildcard, so every reopen and every
    // re-deny names file-read-data explicitly; otherwise the home deny wins and the worktree is unreadable.
    `(allow file-read-data file-read* ${subpaths([policy.root, ...policy.readable])})`,
    // Directory listings of the worktree's ancestors only (literal, not subpath), so getcwd works.
    ...(ancestors(policy.root, home).length ? [`(allow file-read-data ${ancestors(policy.root, home).map(p => `(literal ${quote(p)})`).join(' ')})`] : []),
    '(deny file-read-data file-read* (regex #"-keypair\\.json$") (regex #"/id\\.json$"))',
    `(deny file-read-data file-read* ${subpaths(SECRET_DIRS.map(dir => path.join(home, dir)))})`,
    ';; Keychain: no securityd, so no stored passwords or certificates.',
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc"))',
    ';; Writes: worktree, private home, temp and devices only; pinned verifier files stay read-only.',
    '(deny file-write* (subpath "/"))',
    `(allow file-write* ${subpaths([policy.root, ...policy.writable])})`,
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/ptmx") (literal "/dev/dtracehelper") (regex #"^/dev/(tty|pty|fd/)"))',
    ...(policy.readOnly.length ? [`(deny file-write* ${policy.readOnly.map(p => `(literal ${quote(p)}) (subpath ${quote(p)})`).join(' ')})`] : []),
    ';; Network: only the Surfnet RPC port on loopback.',
    '(deny network*)',
    ...(policy.surfnetPort === undefined ? [] : [`(allow network-outbound (remote ip "localhost:${policy.surfnetPort}"))`]),
    // Listening on loopback exposes nothing beyond this machine. Connecting stays limited to the standard local Solana ports
    // (RPC, websocket, faucet), so a command cannot reach the developer's other local services (databases, wallets, dev servers).
    ...(policy.surfpool === undefined ? [] : ['(allow network-bind network-inbound (local ip "localhost:*"))',
      ...SOLANA_LOCAL_PORTS.map(port => `(allow network-outbound (remote ip "localhost:${port}"))`)]),
  ];
  return `${rules.join('\n')}\n`;
}

/** Seatbelt matches resolved paths (/var is /private/var); a missing leaf keeps its resolved parent. */
const resolved = (p: string): string => {
  try { return realpathSync(p); } catch { return p === path.dirname(p) ? p : path.join(resolved(path.dirname(p)), path.basename(p)); }
};
const unique = (paths: string[]): string[] => [...new Set(paths.map(resolved))];
const within = (child: string, parent: string): boolean => { const rel = path.relative(parent, child); return !rel.startsWith('..') && !path.isAbsolute(rel); };

/** Toolchain roots that host commands read: node, cargo/rustup, solana, anchor (avm) and PATH entries. */
function toolchainRoots(env: NodeJS.ProcessEnv, home: string): string[] {
  const roots = [path.dirname(path.dirname(process.execPath)),
    ...['.cargo', '.rustup', '.local/share/solana', '.avm', '.nvm', '.volta', '.bun', '.fnm'].map(dir => path.join(home, dir))];
  if (env.CARGO_HOME) roots.push(env.CARGO_HOME);
  if (env.RUSTUP_HOME) roots.push(env.RUSTUP_HOME);
  // The entry only, never its parent: ~/Library/pnpm must not open ~/Library.
  for (const dir of (env.PATH ?? '').split(':').filter(path.isAbsolute)) roots.push(dir);
  return roots;
}

/** A linked git worktree's `.git` file points at a gitdir (and its commondir) in the main repo, often under home. */
function gitControlDirs(root: string): string[] {
  let gitdir: string;
  try { gitdir = /^gitdir: (.+)$/m.exec(readFileSync(path.join(root, '.git'), 'utf8'))?.[1] ?? ''; } catch { return []; }
  if (!gitdir) return [];
  gitdir = path.resolve(root, gitdir.trim());
  try { return [gitdir, path.resolve(gitdir, readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim())]; } catch { return [gitdir]; }
}

/** Writes this run's profile into the private home and returns argv wrapped in sandbox-exec. */
export function seatbeltArgv(o: HostRunOptions, root: string, privateHome: string, env: NodeJS.ProcessEnv, argv: string[]): string[] {
  const home = resolved(homedir());
  const cargoHome = env.CARGO_HOME ?? path.join(home, '.cargo');
  const policy: SeatbeltPolicy = {
    home, root: resolved(root),
    writable: unique([privateHome, tmpdir(), '/private/tmp', ...(env.OMS_OUTPUT_DIR ? [env.OMS_OUTPUT_DIR] : []),
      ...o.mounts.extraMounts.filter(mount => mount.mode === 'rw').map(mount => mount.hostPath),
      // Cargo's download caches; cargo/bin stays read-only so a command cannot plant a host binary.
      ...['registry', 'git', '.package-cache', '.package-cache-mutate'].map(entry => path.join(cargoHome, entry))]),
    // A toolchain root that contains home (PATH=~/bin has parent ~) would reopen every repo.
    readable: unique([...toolchainRoots(env, home), ...gitControlDirs(root), ...o.mounts.readOnlyMounts.map(mount => mount.hostPath),
      ...(env.SURFPOOL_BINARY ? [env.SURFPOOL_BINARY] : [])]).filter(dir => !within(home, dir)),
    readOnly: unique(o.protectedPaths ?? []),
    surfnetPort: o.surfnet?.port,
    surfpool: env.SURFPOOL_BINARY,
  };
  const profile = path.join(privateHome, '.oms-seatbelt.sb');
  writeFileSync(profile, seatbeltProfile(policy), { mode: 0o600 });
  return [SANDBOX_EXEC, '-f', profile, ...argv];
}
