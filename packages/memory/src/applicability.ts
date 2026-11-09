import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { Applicability } from './types.ts';
const MAX_LOCKFILE_BYTES = 4 * 1024 * 1024;
function optionalFile(path: string): string {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('Lockfile must be a regular file');
    // The agent writes these files; a huge one would stall the harness in the synchronous parse.
    if (stat.size > MAX_LOCKFILE_BYTES) throw new Error('Lockfile is larger than 4 MiB');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
/** Restrict metadata to release pins, not arbitrary lockfile strings or build metadata.
 * Unknown prerelease labels need a public-vocabulary decision before capture. */
function resolvedVersion(version: string | null): string | null {
  if (version !== null && !/^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:-(?:alpha|beta|rc)\.(?:0|[1-9]\d{0,8}))?$/.test(version)) {
    throw new Error('Unsupported resolved version pin');
  }
  return version;
}
/** Version pins come from resolved lockfiles and the trusted execution manifest. */
export function applicability(workspace: string, runtime: { surfpool: string | null; agave: string | null; rustc: string | null; node: string | null }): Applicability {
  const cargo = optionalFile(join(workspace, 'Cargo.lock'));
  const crates = new Map<string, string>();
  for (const block of cargo.split('[[package]]').slice(1)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (name && version) {
      if (name === 'anchor-lang' && crates.has(name) && crates.get(name) !== version) throw new Error('Ambiguous resolved crate version');
      crates.set(name, version);
    }
  }
  const lock = optionalFile(join(workspace, 'package-lock.json'));
  const npm: unknown = lock ? JSON.parse(lock) : {};
  const packages = (npm as { packages?: Record<string, { version?: unknown }> }).packages ?? {};
  function resolved(name: string): string | null {
    const versions = new Set(Object.entries(packages).filter(([path]) => path.endsWith(`node_modules/${name}`)).map(([, value]) => value.version).filter((v): v is string => typeof v === 'string'));
    if (versions.size > 1) throw new Error('Ambiguous resolved npm version');
    return [...versions][0] ?? null;
  }
  const anchor = crates.get('anchor-lang') ?? null;
  const kit = resolved('@solana/kit');
  const framework = anchor ? 'anchor' : crates.has('pinocchio') ? 'pinocchio' : kit ? 'kit' : resolved('@solana/web3.js') ? 'web3js' : crates.has('solana-program') ? 'native' : 'other';
  const versions = { 'anchor-lang': resolvedVersion(anchor), '@solana/kit': resolvedVersion(kit),
    surfpool: resolvedVersion(runtime.surfpool), agave: resolvedVersion(runtime.agave),
    rustc: resolvedVersion(runtime.rustc), node: resolvedVersion(runtime.node) };
  return { framework, versions, range: Object.fromEntries(Object.entries(versions).filter((entry): entry is [string, string] => entry[1] !== null).map(([name, version]) => [name, `=${version}`])) };
}
