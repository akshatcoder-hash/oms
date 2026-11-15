/** Every execution owns a fresh internal network and a single phase-specific forwarder. */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SandboxError } from './errors.ts';
import { sandboxDocker, type DockerClient } from './docker.ts';
import { removeOwnedResource, requirePinnedImage, type ResourceLabels } from './resources.ts';
import { openHostRelay, type HostRelay } from './host-relay.ts';

const FORWARDER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'forwarder.mjs');
const HOST_ALIAS = 'host.docker.internal';
const RELAY_MOUNT = '/run/oms-host';
// Native Linux Docker resolves the host alias to the bridge gateway, not host
// loopback; Docker Desktop/OrbStack VMs route it to the host but cannot carry
// bind-mounted host Unix sockets.
const RELAY_HOST_LOOPBACK = process.platform === 'linux';

export interface EgressSetup {
  networkName: string;
  forwarderName: string;
  forwarderIP: string;
  forwarderPort: number;
  labels: ResourceLabels;
  relay?: HostRelay;
}

export interface EgressOptions {
  taskName: string;
  forwarderImage: string;
  signal?: AbortSignal;
}

export interface InstallEgressOptions extends EgressOptions {
  allowlist: string[];
}

export interface RunEgressOptions extends EgressOptions {
  surfnetPort: number;
  surfnetTargetHost?: string;
  surfnetTargetPort?: number;
}

async function setupEgress(
  o: EgressOptions,
  phase: 'install' | 'run',
  env: string[],
  port: number,
  docker: DockerClient,
  hostPorts: number[],
): Promise<EgressSetup> {
  requirePinnedImage(o.forwarderImage, 'forwarderImage');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(o.taskName)) throw new SandboxError('E_BAD_ARGUMENT', 'invalid taskName');
  const execution = randomUUID();
  const stem = `oms-${o.taskName}-${phase}-${execution}`;
  const result: EgressSetup = {
    networkName: `${stem}-net`,
    forwarderName: `${stem}-fwd`,
    forwarderIP: '',
    forwarderPort: port,
    labels: { 'oms.component': 'sandbox', 'oms.task': o.taskName, 'oms.execution': execution, 'oms.phase': phase },
  };
  const labelArgs = Object.entries(result.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
  const signal = o.signal;
  let networkAttempted = false;
  let forwarderAttempted = false;
  try {
    signal?.throwIfAborted();
    if (RELAY_HOST_LOOPBACK && hostPorts.length) result.relay = await openHostRelay(hostPorts);
    const relayArgs = result.relay
      ? ['--env', `FWD_HOST_RELAY=${RELAY_MOUNT}`, '-v', `${result.relay.directory}:${RELAY_MOUNT}:ro`]
      : [];
    signal?.throwIfAborted();
    networkAttempted = true;
    await docker.out(['network', 'create', '--internal', ...labelArgs, result.networkName]);
    signal?.throwIfAborted();
    forwarderAttempted = true;
    const id = (
      await docker.out([
        'create',
        '--pull=never',
        '--name',
        result.forwarderName,
        ...labelArgs,
        '--network',
        result.networkName,
        '--network-alias',
        'oms-fwd',
        '--add-host',
        `${HOST_ALIAS}:host-gateway`,
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--user',
        '1000:1000',
        '--tmpfs',
        '/tmp',
        '--pids-limit',
        '64',
        '--memory',
        '128m',
        ...env.flatMap((value) => ['--env', value]),
        ...relayArgs,
        '-v',
        `${FORWARDER_SCRIPT}:/app/forwarder.mjs:ro`,
        o.forwarderImage,
        'node',
        '/app/forwarder.mjs',
      ])
    ).trim();
    signal?.throwIfAborted();
    await docker.out(['network', 'connect', 'bridge', id]);
    signal?.throwIfAborted();
    await docker.out(['start', id]);
    signal?.throwIfAborted();
    const deadline = Date.now() + 15_000;
    for (;;) {
      const logs = await docker.out(['logs', id], signal);
      if (logs.includes('forwarder ready')) break;
      if (Date.now() >= deadline)
        throw new SandboxError('E_TIMEOUT', 'forwarder did not become ready', { name: result.forwarderName });
      await delay(200, undefined, { signal });
    }
    result.forwarderIP = (
      await docker.out(
        ['inspect', '-f', `{{(index .NetworkSettings.Networks "${result.networkName}").IPAddress}}`, id],
        signal,
      )
    ).trim();
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(result.forwarderIP)) {
      throw new SandboxError('E_DOCKER', `forwarder has no IPv4 address on ${result.networkName}`);
    }
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    const failures: unknown[] = [];
    if (forwarderAttempted) {
      try {
        await removeOwnedResource(docker, 'container', result.forwarderName, result.labels);
      } catch (e) {
        failures.push(e);
      }
    }
    if (networkAttempted) {
      try {
        await removeOwnedResource(docker, 'network', result.networkName, result.labels);
      } catch (e) {
        failures.push(e);
      }
    }
    try {
      await result.relay?.close();
    } catch (e) {
      failures.push(e);
    }
    if (failures.length) throw new AggregateError([error, ...failures], 'sandbox setup cleanup failed');
    throw error;
  }
}

export async function setupInstallEgress(
  o: InstallEgressOptions,
  docker: DockerClient = sandboxDocker,
): Promise<EgressSetup> {
  if (!o.allowlist.length || o.allowlist.some((host) => !/^[A-Za-z0-9.-]+:[0-9]+$/.test(host))) {
    throw new SandboxError('E_BAD_ARGUMENT', 'install phase requires a non-empty host:port allowlist');
  }
  const hostPorts = o.allowlist
    .map((entry) => entry.toLowerCase().split(':'))
    .filter(([host]) => host === HOST_ALIAS)
    .map(([, port]) => Number(port));
  return setupEgress(o, 'install', ['FWD_MODE=proxy', `FWD_ALLOW=${o.allowlist.join(',')}`], 3128, docker, hostPorts);
}

export async function setupRunEgress(o: RunEgressOptions, docker: DockerClient = sandboxDocker): Promise<EgressSetup> {
  for (const port of [o.surfnetPort, o.surfnetTargetPort ?? o.surfnetPort]) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535)
      throw new SandboxError('E_BAD_ARGUMENT', `invalid surfnet port: ${port}`);
  }
  const targetHost = o.surfnetTargetHost ?? HOST_ALIAS;
  const targetPort = o.surfnetTargetPort ?? o.surfnetPort;
  return setupEgress(
    o,
    'run',
    [
      'FWD_MODE=forward',
      `FWD_LISTEN_PORT=${o.surfnetPort}`,
      `FWD_TARGET_HOST=${targetHost}`,
      `FWD_TARGET_PORT=${targetPort}`,
    ],
    o.surfnetPort,
    docker,
    targetHost.toLowerCase() === HOST_ALIAS ? [targetPort] : [],
  );
}

/** Cleanup deliberately ignores the cancelled execution signal and reports failures. */
export async function teardownEgress(e: EgressSetup, docker: DockerClient = sandboxDocker): Promise<void> {
  const failures: unknown[] = [];
  try {
    await removeOwnedResource(docker, 'container', e.forwarderName, e.labels);
  } catch (error) {
    failures.push(error);
  }
  try {
    await removeOwnedResource(docker, 'network', e.networkName, e.labels);
  } catch (error) {
    failures.push(error);
  }
  try {
    await e.relay?.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, 'sandbox egress cleanup failed');
}
