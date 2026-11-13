/**
 * Pure docker-argument builder. Keeping this free of I/O and process.env lets
 * unit tests assert the exact invocation without a daemon.
 *
 * Invariants:
 *  - baseline hardening flags are always present and first;
 *  - env is explicit only: nothing is inherited from the host process;
 *  - argv is passed through as an array — oms code never builds a shell string.
 *    The model's own command may be `['sh', '-c', '<model command string>]`,
 *    which runs INSIDE the container; nothing is ever concatenated on the host.
 */

import type { MountPlan } from './mounts.ts';
import { SandboxError } from './errors.ts';

export interface Limits {
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
}

export interface BuildRunArgsOptions {
  image: string;
  name: string;
  /** Container argv, e.g. ['sh', '-c', 'npm ci']. Passed verbatim after the image. */
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  mounts: MountPlan;
  network?: string;
  addHosts?: Array<{ host: string; ip: string }>;
  labels?: Record<string, string>;
  limits?: Limits;
  /** Long-lived containers need a reaper for orphans; per-command containers die with their one process. */
  init?: boolean;
  /** Per-command containers remove themselves; a session container is removed by its owner, so a racing `docker rm` never meets auto-removal. */
  autoRemove?: boolean;
}

export const DEFAULT_LIMITS: Required<Limits> = { memoryMb: 2048, cpus: 2, pidsLimit: 256 };

/** Bind-mounted files retain their host ownership; no permission widening is needed. */
export function sandboxUser(): string {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0 || gid === 0) {
    throw new SandboxError('E_BAD_ARGUMENT', 'sandbox requires a non-root POSIX host user/group identity');
  }
  return `${uid}:${gid}`;
}

export function buildRunArgs(o: BuildRunArgsOptions): string[] {
  const limits = { ...DEFAULT_LIMITS, ...o.limits };
  const user = sandboxUser();
  const [uid, gid] = user.split(':');
  const args: string[] = [
    'run',
    ...(o.autoRemove === false ? [] : ['--rm']),
    '--pull=never',
    ...(o.init ? ['--init'] : []),
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    user,
    '--tmpfs',
    '/tmp',
    '--pids-limit',
    String(limits.pidsLimit),
    '--memory',
    `${limits.memoryMb}m`,
    '--cpus',
    String(limits.cpus),
    '--name',
    o.name,
  ];
  for (const [k, v] of Object.entries(o.labels ?? {})) {
    args.push('--label', `${k}=${v}`);
  }
  if (o.network) {
    args.push('--network', o.network);
  }
  for (const h of o.addHosts ?? []) {
    args.push('--add-host', `${h.host}:${h.ip}`);
  }
  if (o.cwd) {
    args.push('-w', o.cwd);
  }
  for (const [k, v] of Object.entries(o.env ?? {})) {
    args.push('--env', `${k}=${v}`);
  }
  // Order matters for nesting: project first, then extra, then :ro overlays and
  // named volumes on top (the runtime mounts shallower destinations first).
  const { projectMount, extraMounts, readOnlyMounts, volumes, shadowMounts } = o.mounts;
  args.push('-v', `${projectMount.hostPath}:${projectMount.containerPath}:${projectMount.mode}`);
  for (const m of extraMounts) {
    args.push('-v', `${m.hostPath}:${m.containerPath}:${m.mode}`);
  }
  for (const m of readOnlyMounts) {
    args.push('-v', `${m.hostPath}:${m.containerPath}:${m.mode}`);
  }
  for (const v of volumes) {
    args.push('--volume', `${v.name}:${v.containerPath}${v.readOnly ? ':ro' : ''}`);
  }
  for (const s of shadowMounts) {
    args.push('--tmpfs', `${s}:rw,size=64k,uid=${uid},gid=${gid},mode=700`);
  }
  args.push(o.image, ...o.argv);
  return args;
}

/** Env added to install-phase containers pointing at the allowlisting proxy. */
export function installProxyEnv(proxyUrl: string): Record<string, string> {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    npm_config_proxy: proxyUrl,
    npm_config_https_proxy: proxyUrl,
    NO_PROXY: '',
    no_proxy: '',
  };
}
