/** Explicit whole-task cleanup. Normal execution only tears down its own resources. */
import { sandboxDocker, type DockerClient } from './docker.ts';
import { removeOwnedResource } from './resources.ts';
import { SandboxError } from './errors.ts';

export interface CleanupResult {
  containers: string[];
  networks: string[];
  volumes: string[];
}

async function listByLabel(kind: 'container' | 'network' | 'volume', taskName: string, docker: DockerClient): Promise<string[]> {
  const args = kind === 'container' ? ['ps', '-a'] : [kind, 'ls'];
  const out = await docker.out([
    ...args, '--filter', 'label=oms.component=sandbox', '--filter', `label=oms.task=${taskName}`,
    '--format', kind === 'container' ? '{{.Names}}' : '{{.Name}}',
  ]);
  return out.split('\n').map(name => name.trim()).filter(Boolean);
}

/** Lookup/ownership/removal failures surface; they are never treated as successful cleanup. */
export async function removeTaskResources(taskName: string, docker: DockerClient = sandboxDocker): Promise<CleanupResult> {
  const result: CleanupResult = { containers: [], networks: [], volumes: [] };
  const labels = { 'oms.component': 'sandbox', 'oms.task': taskName };
  for (const kind of ['container', 'network', 'volume'] as const) {
    for (const name of await listByLabel(kind, taskName, docker)) {
      if (await removeOwnedResource(docker, kind, name, labels)) {
        if (kind === 'container') result.containers.push(name);
        else if (kind === 'network') result.networks.push(name);
        else result.volumes.push(name);
      }
    }
  }
  return result;
}

export async function hasLeftovers(taskName: string, docker: DockerClient = sandboxDocker): Promise<{ leftovers: boolean; detail: string[] }> {
  const detail: string[] = [];
  for (const kind of ['container', 'network', 'volume'] as const) detail.push(...await listByLabel(kind, taskName, docker));
  return { leftovers: detail.length > 0, detail };
}

/** Startup recovery intentionally never lists, removes, or prunes data volumes. */
export async function recoverTaskExecutionResources(
  taskName: string, assertOwner: () => void, docker: DockerClient = sandboxDocker,
): Promise<Pick<CleanupResult, 'containers' | 'networks'>> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(taskName)) throw new SandboxError('E_BAD_ARGUMENT', 'invalid recovery task');
  const resources: Array<{ kind: 'container' | 'network'; name: string; id: string; execution: string; members: string[] }> = [];
  for (const kind of ['container', 'network'] as const) {
    // Query by task alone so a conflicting component label fails rather than disappearing.
    const names = (await docker.out([...(kind === 'container' ? ['ps', '-a'] : ['network', 'ls']),
      '--filter', `label=oms.task=${taskName}`, '--format', kind === 'container' ? '{{.Names}}' : '{{.Name}}']))
      .split('\n').map(name => name.trim()).filter(Boolean);
    for (const name of names) {
      const raw = await docker.out(kind === 'container'
        ? ['inspect', '--type', 'container', '--format', '{{json .}}', name]
        : ['network', 'inspect', '--format', '{{json .}}', name]);
      let metadata: { Id?: unknown; Name?: unknown; Config?: { Labels?: Record<string, unknown> }; Labels?: Record<string, unknown>; Containers?: Record<string, unknown> };
      try { metadata = JSON.parse(raw); } catch { throw new SandboxError('E_RESOURCE_OWNERSHIP', 'Invalid recovery metadata'); }
      const labels = kind === 'container' ? metadata?.Config?.Labels : metadata?.Labels;
      if (!metadata || typeof metadata.Id !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.Id) ||
          (kind === 'container' ? String(metadata.Name).replace(/^\//, '') : metadata.Name) !== name ||
          !name.startsWith(`oms-${taskName}-`) || labels?.['oms.component'] !== 'sandbox' ||
          labels?.['oms.task'] !== taskName || typeof labels?.['oms.execution'] !== 'string' || !labels['oms.execution'] ||
          !['run', 'install'].includes(String(labels?.['oms.phase']))) {
        throw new SandboxError('E_RESOURCE_OWNERSHIP', 'Task resources have foreign or incomplete execution identity');
      }
      if (kind === 'network' && (!metadata.Containers || typeof metadata.Containers !== 'object' || Array.isArray(metadata.Containers))) {
        throw new SandboxError('E_RESOURCE_OWNERSHIP', 'Network membership could not be verified');
      }
      resources.push({ kind, name, id: metadata.Id, execution: labels['oms.execution'],
        members: kind === 'network' ? Object.keys(metadata.Containers!) : [] });
    }
  }
  const containers = new Set(resources.filter(resource => resource.kind === 'container').map(resource => resource.id));
  if (resources.some(resource => resource.members.some(id => !containers.has(id)))) {
    throw new SandboxError('E_RESOURCE_OWNERSHIP', 'A task network contains a foreign execution');
  }
  const result: Pick<CleanupResult, 'containers' | 'networks'> = { containers: [], networks: [] };
  for (const resource of resources) {
    assertOwner();
    // Immutable daemon IDs prevent a replaced name from redirecting deletion.
    await docker.out(resource.kind === 'container' ? ['rm', '-f', resource.id] : ['network', 'rm', resource.id]);
    result[resource.kind === 'container' ? 'containers' : 'networks'].push(resource.name);
  }
  for (const kind of ['container', 'network'] as const) {
    assertOwner();
    const remaining = await docker.out([...(kind === 'container' ? ['ps', '-a'] : ['network', 'ls']),
      '--filter', `label=oms.task=${taskName}`, '--format', '{{.ID}}']);
    if (remaining.trim()) throw new SandboxError('E_RESOURCE_OWNERSHIP', 'Execution resources changed during recovery');
  }
  return result;
}
