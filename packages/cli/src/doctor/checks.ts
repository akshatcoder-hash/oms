import { executionBackend, omsCommand, type BackendName } from '@oms/engine';
/** `optional`: never blocks; listed apart from the install path (Docker in host mode). */
export type Severity = 'blocking' | 'warning' | 'info' | 'optional';
export type Status = 'ok' | 'fail';

export interface CheckResult {
  id: string;
  title: string;
  status: Status;
  severity: Severity;
  detail: string;
  fix?: string;
}

export interface Env {
  platform: NodeJS.Platform;
  nodeVersion: string;
  freeDiskGb: () => Promise<number>;
  exec: (bin: string, args: string[]) => Promise<{ ok: boolean; out: string }>;
  rpcHealth: (url: string) => Promise<{ ok: boolean; out: string }>;
  env: Record<string, string | undefined>;
}

export interface DoctorOptions {
  backend?: BackendName;
  surfnetRpcUrl?: string;
  minNodeVersion: string;
  surfpoolBinary?: string;
  sandboxImage?: string;
  pinnedSurfpool: string;
  /** Below this OMS cannot run reliably (Surfpool state, builds): blocking. */
  minFreeDiskGb: number;
  /** Below this, Anchor/Rust builds and the Docker sandbox images may run out of space: a warning only. */
  recommendedFreeDiskGb: number;
  needsPrograms: boolean;
}

export const DEFAULT_OPTIONS: DoctorOptions = {
  minNodeVersion: '22.19.0',
  pinnedSurfpool: '1.7.0',
  minFreeDiskGb: 1,
  recommendedFreeDiskGb: 5,
  needsPrograms: false,
};

const macFix = (brewLine: string, other: string, platform: NodeJS.Platform) =>
  platform === 'darwin' ? brewLine : other;

export async function runChecks(env: Env, opts: DoctorOptions): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const backend = executionBackend(opts.backend ?? (opts.sandboxImage ? 'docker' : 'host'));

  const actual = env.nodeVersion.split('.').map(Number);
  const minimum = opts.minNodeVersion.split('.').map(Number);
  let nodeSupported = actual.length === 3 && actual.every(Number.isSafeInteger);
  if (nodeSupported) {
    for (let part = 0; part < 3; part++) {
      if (actual[part] !== minimum[part]) {
        nodeSupported = actual[part]! > minimum[part]!;
        break;
      }
    }
  }
  out.push({
    id: 'node',
    title: 'Node.js',
    status: nodeSupported ? 'ok' : 'fail',
    severity: 'blocking',
    detail: `v${env.nodeVersion} (need >=${opts.minNodeVersion})`,
    fix: `Run: nvm install ${opts.minNodeVersion} (if nvm is installed), or install Node from https://nodejs.org`,
  });

  const surf = await env.exec(opts.surfpoolBinary ?? 'surfpool', ['--version']);
  const version = /^surfpool\s+([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/.exec(surf.out.trim())?.[1];
  const surfOk = surf.ok && version === opts.pinnedSurfpool;
  out.push({
    id: 'surfpool',
    title: 'Surfpool',
    status: surfOk ? 'ok' : 'fail',
    severity: 'blocking',
    detail: surf.ok ? `${surf.out} (pinned ${opts.pinnedSurfpool})` : surf.out,
    fix: `Run \`${omsCommand(env.env)} doctor --install\` to download Surfpool ${opts.pinnedSurfpool} and verify its SHA-256. Or install it yourself and run \`${omsCommand(env.env)} doctor --surfpool-binary /absolute/path/to/surfpool\`.`,
  });

  const sol = await env.exec('solana', ['--version']);
  out.push({
    id: 'solana',
    title: 'Solana CLI',
    status: sol.ok ? 'ok' : 'fail',
    severity: opts.needsPrograms ? 'blocking' : 'warning',
    detail: sol.ok
      ? sol.out
      : [sol.out === 'not installed' ? '' : sol.out, 'The Solana CLI is needed to build and deploy programs.']
          .filter(Boolean)
          .join(' '),
    fix: macFix(
      'Run `brew install solana`.',
      'See https://solana.com/docs/intro/installation for installation instructions.',
      env.platform,
    ),
  });

  // Seatbelt counts only if it actually confines a process here. An inline profile, as OMS uses: macOS 27 kills processes
  // under the built-in named profiles.
  const seatbelt =
    backend.probesSeatbelt &&
    env.platform === 'darwin' &&
    (await env.exec('sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', '/usr/bin/true'])).ok;
  out.push({
    id: 'backend',
    title: 'Execution backend',
    status: 'ok',
    severity: 'info',
    detail: backend.doctorDetail(seatbelt),
  });
  const docker = await env.exec('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (!backend.requiresDocker) {
    out.push({
      id: 'docker',
      title: 'Docker',
      status: docker.ok ? 'ok' : 'fail',
      severity: 'optional',
      detail: docker.ok
        ? `server ${docker.out}`
        : 'not running; needed only for the benchmark grader and --sandbox docker',
    });
  } else {
    out.push({
      id: 'docker',
      title: 'Docker daemon (Docker mode)',
      status: docker.ok ? 'ok' : 'fail',
      severity: 'blocking',
      detail: docker.ok ? `server ${docker.out}` : docker.out,
      fix: macFix(
        'brew install colima docker && colima start --vm-type vz',
        'For --sandbox docker: install Docker Engine, then run: sudo systemctl start docker. Host mode needs no Docker.',
        env.platform,
      ),
    });

    if (docker.ok) {
      const ctx = await env.exec('docker', ['context', 'show']);
      if (ctx.ok) {
        out.push({
          id: 'docker-context',
          title: 'Docker context',
          status: 'ok',
          severity: 'info',
          detail: ctx.out,
        });
      }
      if (opts.sandboxImage) {
        const image = await env.exec('docker', ['image', 'inspect', '--format', '{{.Id}}', opts.sandboxImage]);
        out.push({
          id: 'sandbox-image',
          title: 'Approved sandbox image',
          severity: 'blocking',
          status: image.ok && /^sha256:[a-f0-9]{64}$/.test(image.out) ? 'ok' : 'fail',
          detail: image.out || 'approved image is not cached',
          fix: `Pull the approved digest explicitly: docker pull ${opts.sandboxImage}`,
        });
      }
    }
  }

  const programSeverity: Severity = opts.needsPrograms ? 'blocking' : 'info';
  const anchor = await env.exec('anchor', ['--version']);
  out.push({
    id: 'anchor',
    title: 'Anchor (host)',
    status: anchor.ok ? 'ok' : 'fail',
    severity: programSeverity,
    detail: anchor.ok ? anchor.out : 'not installed on host; required only for Anchor program builds',
    fix: 'For Anchor builds, install AVM, then run: avm install 0.32.1 && avm use 0.32.1. Match your project version.',
  });

  const free = await env.freeDiskGb();
  out.push({
    id: 'disk',
    title: 'Free disk',
    status: free >= opts.recommendedFreeDiskGb ? 'ok' : 'fail',
    severity: free >= opts.minFreeDiskGb ? 'warning' : 'blocking',
    detail:
      free >= opts.recommendedFreeDiskGb
        ? `${free.toFixed(1)} GB free`
        : free >= opts.minFreeDiskGb
          ? `${free.toFixed(1)} GB free; OMS runs, but Anchor/Rust builds and --sandbox docker may need up to ${opts.recommendedFreeDiskGb} GB`
          : `${free.toFixed(1)} GB free (need >=${opts.minFreeDiskGb})`,
    fix: 'Free disk space',
  });

  if (opts.surfnetRpcUrl) {
    const rpc = await env.rpcHealth(opts.surfnetRpcUrl);
    out.push({
      id: 'surfnet-rpc',
      title: 'Surfnet RPC',
      status: rpc.ok ? 'ok' : 'fail',
      severity: 'blocking',
      detail: rpc.out,
      fix: 'Start a surfnet: surfpool start --ci --no-tui --offline',
    });
  }

  const hasKey = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY'].some((k) =>
    Boolean(env.env[k]),
  );
  out.push({
    id: 'model-key',
    title: 'Model access',
    status: hasKey ? 'ok' : 'fail',
    severity: 'warning',
    detail: hasKey
      ? 'provider environment configured; login not validated'
      : 'no provider environment configured; saved subscription login not checked',
    fix: 'In OMS, run /connect, then /model. Subscription access does not require a provider API key.',
  });

  return out;
}

export interface Summary {
  blocking: number;
  warnings: number;
  exitCode: 0 | 1;
}

export function summarize(results: CheckResult[]): Summary {
  const blocking = results.filter((r) => r.status === 'fail' && r.severity === 'blocking').length;
  const warnings = results.filter((r) => r.status === 'fail' && r.severity === 'warning').length;
  return { blocking, warnings, exitCode: blocking > 0 ? 1 : 0 };
}

export function renderText(results: CheckResult[], environment: Env['env'] = process.env): string {
  const lines: string[] = [];
  const groups: Array<[string, (r: CheckResult) => boolean]> = [
    ['Blocking', (r) => r.status === 'fail' && r.severity === 'blocking'],
    ['Warnings', (r) => r.status === 'fail' && r.severity === 'warning'],
    ['Ready', (r) => r.status === 'ok' && r.severity !== 'optional'],
    ['Not needed', (r) => r.status === 'fail' && r.severity === 'info'],
    ['Optional (benchmark / --sandbox docker)', (r) => r.severity === 'optional'],
  ];
  for (const [name, pred] of groups) {
    const rows = results.filter(pred);
    if (rows.length === 0) continue;
    lines.push(name);
    for (const r of rows) {
      lines.push(`  ${r.title.padEnd(16)} ${r.detail}`);
      if (r.status === 'fail' && r.fix && (r.severity === 'blocking' || r.severity === 'warning'))
        lines.push(`    fix: ${r.fix}`);
    }
    lines.push('');
  }
  const s = summarize(results);
  lines.push(
    s.blocking === 0
      ? `oms doctor: ready. Run \`${omsCommand(environment)}\` to launch OMS.`
      : `oms doctor: ${s.blocking} blocking issue(s)`,
  );
  return lines.join('\n');
}
