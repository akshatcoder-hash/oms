import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { buildRunArgs, removeOwnedResource, requirePinnedImage, sandboxDocker, type DockerClient } from '@oms/sandbox';
import { privateDirectory } from '../../../review/src/report/storage.ts';
import type { StaticExecutionPort, StaticRequest } from '../../../review/src/static/run.ts';

/** Host-owned build receipt or OMS_REVIEW_TOOLS_IMAGE, never project configuration. */
export function configuredReviewToolsImage(): string | undefined {
  const receipt = new URL('../../../../.tmp/review-tools/image.json', import.meta.url);
  const image: unknown = process.env.OMS_REVIEW_TOOLS_IMAGE || (existsSync(receipt)
    ? JSON.parse(readFileSync(receipt, 'utf8'))[process.arch] : undefined);
  if (image == null) return undefined;
  if (typeof image !== 'string') throw new Error('Installed review tools image must be a pinned image reference');
  requirePinnedImage(image, 'review tools image');
  return image;
}

export function reviewToolsImage(): string {
  const image = configuredReviewToolsImage();
  if (!image) throw new Error('No local review tools image configured; run scripts/build-review-tools.sh or set OMS_REVIEW_TOOLS_IMAGE to an immutable image');
  return image;
}

function checkedRequest(request: StaticRequest): { argv: string[]; files: Map<string, string> } {
  if (request.network !== 'none' || request.readOnly !== true || request.cwd !== '/work' ||
      !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 300000 ||
      !Number.isSafeInteger(request.outputBytes) || request.outputBytes < 1 || request.outputBytes > 4 * 1024 * 1024 ||
      request.files.size < 1 || request.files.size > 2) throw new Error('Invalid static execution request');
  const files = new Map(request.files);
  for (const [file, source] of files) {
    if (typeof file !== 'string' || !file || /[\\:\x00-\x1f\x7f]/.test(file) ||
        file.split('/').some(part => !part || part === '.' || part === '..') ||
        typeof source !== 'string' || Buffer.byteLength(source) > 512 * 1024) throw new Error('Invalid static input');
  }
  const argv = [...request.argv];
  const file = argv[2];
  let expected: string[];
  let inputs: string[];
  if (request.tool === 'oms-sast' && file && argv[1] === '--file' && file.endsWith('.rs')) {
    const lockfile = argv[4];
    if (lockfile !== undefined && lockfile.split('/').at(-1) !== 'Cargo.lock') throw new Error('Invalid static command');
    expected = ['oms-sast', '--file', file, ...(lockfile === undefined ? [] : ['--lockfile', lockfile])];
    inputs = [file, ...(lockfile === undefined ? [] : [lockfile])];
  } else if (request.tool === 'oms-sast' && file?.split('/').at(-1) === 'Cargo.toml' && argv[1] === '--manifest') {
    expected = ['oms-sast', '--manifest', file]; inputs = [file];
  } else if (request.tool === 'oms-sast' && argv[1] === '--inventory' &&
      (file?.endsWith('.rs') || file?.split('/').at(-1) === 'Cargo.toml')) {
    expected = ['oms-sast', '--inventory', file!]; inputs = [file!];
  } else if (request.tool === 'cargo-audit') {
    const lockfile = argv[6]?.slice('/work/'.length);
    if (!argv[6]?.startsWith('/work/') || lockfile?.split('/').at(-1) !== 'Cargo.lock') throw new Error('Invalid static command');
    expected = ['cargo-audit', 'audit', '--no-fetch', '--db', '/opt/advisory-db', '--file', `/work/${lockfile}`, '--json'];
    inputs = [lockfile!];
  } else throw new Error('Invalid static command');
  if (JSON.stringify(argv) !== JSON.stringify(expected) || files.size !== inputs.length || inputs.some(path => !files.has(path))) {
    throw new Error('Invalid static command');
  }
  return { argv, files };
}

/** scratchRoot is private host state, outside the reviewed workspace. Only
 * captured inputs are mounted; no credentials, workspace or network is exposed.
 * A failed container cleanup retains its inputs for host recovery. */
export function createStaticExecutionPort(
  options: { scratchRoot: string; image?: string }, docker: DockerClient = sandboxDocker,
): StaticExecutionPort {
  const image = options.image ?? reviewToolsImage();
  requirePinnedImage(image, 'review tools image');
  const root = options.scratchRoot;
  if (!isAbsolute(root) || /[:,\x00-\x1f\x7f]/.test(root)) throw new Error('Invalid review scratch root');
  return { async run(request) {
    const { argv, files } = checkedRequest(request);
    // Capture validated limits before the first await, just like argv and files.
    const { timeoutMs, outputBytes } = request;
    await mkdir(root, { recursive: true, mode: 0o700 });
    await privateDirectory(root);
    const directory = await mkdtemp(join(root, 'static-'));
    const name = `oms-review-static-${randomUUID()}`;
    const labels = { 'oms.component': 'review-static', 'oms.execution': randomUUID() };
    const controller = new AbortController();
    let timedOut = false;
    let truncated = false;
    let attempted = false;
    let retained = 0;
    let stderrBytes = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      for (const [file, source] of files) {
        await mkdir(dirname(join(directory, file)), { recursive: true, mode: 0o700 });
        await writeFile(join(directory, file), source, { flag: 'wx', mode: 0o400 });
      }
      const args = buildRunArgs({ image, name, argv, cwd: '/work', network: 'none', labels,
        env: { HOME: '/tmp', CARGO_HOME: '/tmp/cargo' },
        mounts: { projectMount: { hostPath: directory, containerPath: '/work', mode: 'ro' },
          extraMounts: [], readOnlyMounts: [], volumes: [], shadowMounts: [] } });
      args[0] = 'create';
      args[args.indexOf('--tmpfs') + 1] = '/tmp:rw,noexec,nosuid,nodev,size=64m';
      // Docker's own logs must not bypass the bounded host collector.
      args.splice(1, 0, '--log-driver', 'none');
      controller.signal.throwIfAborted();
      attempted = true;
      // Creation is bounded by DockerClient, not interrupted mid-mutation.
      const id = (await docker.out(args)).trim();
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid static container identity');
      controller.signal.throwIfAborted();
      const exitCode = await docker.capture(['start', '--attach', id], { signal: controller.signal,
        stdout(chunk) {
          const take = Math.min(chunk.length, outputBytes - retained);
          if (take > 0) { chunks.push(Buffer.from(chunk.subarray(0, take))); retained += take; }
          if (take < chunk.length) { truncated = true; controller.abort(); }
        },
        stderr(chunk) {
          stderrBytes += chunk.length;
          if (stderrBytes > outputBytes) { truncated = true; controller.abort(); }
        } });
      return { exitCode: timedOut ? 124 : exitCode, stdout: Buffer.concat(chunks).toString('utf8'), timedOut, truncated };
    } catch {
      if (timedOut) return { exitCode: 124, stdout: '', timedOut, truncated };
      throw new Error('Static tool execution failed');
    } finally {
      clearTimeout(timer);
      try {
        if (attempted) await removeOwnedResource(docker, 'container', name, labels);
      } catch { throw new Error('Static container cleanup failed; retained inputs require host recovery'); }
      await rm(directory, { recursive: true, force: true });
    }
  } };
}
