import { SandboxError } from './errors.ts';
import type { DockerClient } from './docker.ts';

export type ResourceLabels = Record<string, string>;

export function requirePinnedImage(image: string, field: string): void {
  if (typeof image !== 'string' || !/^(?:sha256:[a-f0-9]{64}|[^\s@]+@sha256:[a-f0-9]{64})$/.test(image)) {
    throw new SandboxError('E_BAD_ARGUMENT', `${field} requires an approved local sha256 image ID or repository@sha256 digest; images are never pulled implicitly`);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function metadata(raw: string, name: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch {
    throw new SandboxError('E_RESOURCE_OWNERSHIP', `invalid Docker metadata for ${name}`);
  }
  if (!record(value)) throw new SandboxError('E_RESOURCE_OWNERSHIP', `invalid Docker metadata for ${name}`);
  return value;
}

function assertLabels(actual: unknown, expected: ResourceLabels, name: string): void {
  if (!record(actual) || Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
    throw new SandboxError('E_RESOURCE_OWNERSHIP', `refusing foreign or misidentified Docker resource ${name}`, { name });
  }
}

/** Existing data is never replaced. Lookup failure is not evidence of absence. */
export async function ensureLabeledVolume(docker: DockerClient, name: string, taskName: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const names = (await docker.out(['volume', 'ls', '--format', '{{.Name}}'], signal)).split('\n').map(n => n.trim());
  if (!names.includes(name)) {
    signal.throwIfAborted();
    // Do not interrupt mutations: cancellation waits for the bounded Docker
    // call, then cleanup can observe every resource it may have created.
    await docker.out(['volume', 'create', '--label', 'oms.component=sandbox', '--label', `oms.task=${taskName}`, name]);
  }
  const value = metadata(await docker.out(['volume', 'inspect', '--format', '{{json .}}', name], signal), name);
  if (value.Name !== name) throw new SandboxError('E_RESOURCE_OWNERSHIP', `Docker returned the wrong volume for ${name}`);
  assertLabels(value.Labels, { 'oms.component': 'sandbox', 'oms.task': taskName }, name);
}

/** Inspect exact identity before deletion; never delete a same-named foreign resource. */
export async function removeOwnedResource(
  docker: DockerClient, kind: 'container' | 'network' | 'volume', name: string, labels: ResourceLabels,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await docker.out(kind === 'container'
      ? ['inspect', '--type', 'container', '--format', '{{json .}}', name]
      : [kind, 'inspect', '--format', '{{json .}}', name]);
  } catch (error) {
    const stderr = error instanceof SandboxError ? error.details.stderr : undefined;
    if (typeof stderr === 'string' && /(?:No such (?:container|object|network|volume)|network .+ not found)/i.test(stderr)) return false;
    throw error;
  }
  const value = metadata(raw, name);
  const actualName = kind === 'container' && typeof value.Name === 'string' ? value.Name.replace(/^\//, '') : value.Name;
  const actualLabels = kind === 'container' && record(value.Config) ? value.Config.Labels : value.Labels;
  if (actualName !== name || (kind !== 'volume' && (typeof value.Id !== 'string' || !value.Id))) {
    throw new SandboxError('E_RESOURCE_OWNERSHIP', `Docker returned the wrong ${kind} for ${name}`);
  }
  assertLabels(actualLabels, labels, name);
  const id = kind === 'volume' ? name : value.Id as string;
  await docker.out(kind === 'container' ? ['rm', '-f', id] : [kind, 'rm', id]);
  return true;
}

/** Host libraries a trusted Surfpool binary needs inside the verifier and agent containers (read-only bind mounts). */
export const SURFPOOL_LIBS = ['/lib64/ld-linux-x86-64.so.2', '/lib/x86_64-linux-gnu/libc.so.6',
  '/lib/x86_64-linux-gnu/libm.so.6', '/lib/x86_64-linux-gnu/libgcc_s.so.1'] as const;
