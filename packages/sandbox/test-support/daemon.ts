import assert from 'node:assert/strict';
import { SandboxError } from '../src/errors.ts';
import type { CaptureOptions, DockerClient } from '../src/docker.ts';

export const IMAGE = `sha256:${'a'.repeat(64)}`;
export type Labels = Record<string, string>;
export type Container = {
  Id: string;
  Name: string;
  Config: { Labels: Labels };
  args: string[];
  network: string;
  bridge: boolean;
  running: boolean;
};

export function values(args: string[], flag: string): string[] {
  return args.flatMap((v, i) => (v === flag ? [args[i + 1]!] : []));
}
export function labels(args: string[]): Labels {
  return Object.fromEntries(
    values(args, '--label').map((v) => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)]),
  );
}
function missing(kind: string): never {
  throw new SandboxError('E_DOCKER', 'lookup failed', { stderr: `Error: No such ${kind}` });
}

/** Stateful daemon double: exercises ownership, persistence and overlapping lifetimes without Docker. */
export class Daemon implements DockerClient {
  calls: string[][] = [];
  volumes = new Map<string, { Name: string; Labels: unknown; sentinel?: string }>();
  networks = new Map<string, { Id: string; Name: string; Labels: Labels; Internal: boolean }>();
  containers = new Map<string, Container>();
  executions: Container[] = [];
  fail?: (args: string[]) => void;
  rawVolumeMetadata?: string;
  onExecute?: (container: Container, options: CaptureOptions) => Promise<number>;
  /** Every `docker exec` run through capture, for session tests. */
  execs: Array<{ container: Container; argv: string[] }> = [];
  /** Every sweep `docker exec` run through out; the idle-process lookup answers PID 7 and is not recorded. */
  sweeps: Container[] = [];
  onExec?: (container: Container, argv: string[], options: CaptureOptions) => Promise<number>;
  sequence = 0;

  async out(args: string[], signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    this.calls.push([...args]);
    this.fail?.(args);
    const name = args.at(-1)!;
    if (args[0] === 'volume') {
      if (args[1] === 'ls') return [...this.volumes.keys()].join('\n');
      if (args[1] === 'inspect') {
        const volume = this.volumes.get(name);
        if (!volume) missing('volume');
        return this.rawVolumeMetadata ?? JSON.stringify(volume);
      }
      if (args[1] === 'create') {
        if (!this.volumes.has(name)) this.volumes.set(name, { Name: name, Labels: labels(args) });
        return name;
      }
      assert.fail('normal execution must never remove a volume');
    }
    if (args[0] === 'network') {
      if (args[1] === 'create') {
        assert.ok(!this.networks.has(name), 'must not reuse a network');
        this.networks.set(name, {
          Id: `net-${++this.sequence}`,
          Name: name,
          Labels: labels(args),
          Internal: args.includes('--internal'),
        });
        return this.networks.get(name)!.Id;
      }
      if (args[1] === 'inspect') {
        const network = this.networks.get(name);
        if (!network) missing('network');
        return JSON.stringify(network);
      }
      if (args[1] === 'connect') {
        const c = [...this.containers.values()].find((c) => c.Id === name || c.Name === name)!;
        c.bridge = true;
        return '';
      }
      if (args[1] === 'rm') {
        const entry = [...this.networks].find(([, n]) => n.Id === name);
        assert.ok(entry, 'network removal must use an inspected ID');
        this.networks.delete(entry[0]);
        return '';
      }
    }
    if (args[0] === 'create') {
      const n = values(args, '--name')[0]!;
      assert.ok(!this.containers.has(n), 'must not replace a container');
      const container: Container = {
        Id: `ctr-${++this.sequence}`,
        Name: n,
        Config: { Labels: labels(args) },
        args,
        network: values(args, '--network')[0]!,
        bridge: false,
        running: false,
      };
      this.containers.set(n, container);
      return container.Id;
    }
    if (args[0] === 'start') {
      const started = [...this.containers.values()].find((c) => c.Id === name);
      if (started) started.running = true;
      return name;
    }
    if (args[0] === 'exec') {
      const swept = [...this.containers.values()].find((c) => c.Id === args[1]);
      if (!swept?.running)
        throw new SandboxError('E_DOCKER', 'exec failed', { stderr: `Error: container ${args[1]} is not running` });
      if (!args.includes('oms-sweep')) return '7';
      this.sweeps.push(swept);
      return '';
    }
    if (args[0] === 'logs') return 'forwarder ready';
    if (args[0] === 'inspect') {
      const container = [...this.containers.values()].find((c) => c.Name === name || c.Id === name);
      if (!container) missing('container');
      if (args.includes('{{.State.Running}}')) {
        const states = args.slice(args.indexOf('{{.State.Running}}') + 1).map((id) => {
          const known = [...this.containers.values()].find((c) => c.Name === id || c.Id === id);
          if (!known) missing('container');
          return String(known.running);
        });
        return states.join('\n');
      }
      if (args.includes('-f')) return args.some((a) => a.includes('.State.ExitCode')) ? '0' : '172.25.0.2';
      return JSON.stringify(container);
    }
    if (args[0] === 'rm') {
      const entry = [...this.containers].find(([, c]) => c.Id === name);
      assert.ok(entry, 'container removal must use an inspected ID');
      this.containers.delete(entry[0]);
      return '';
    }
    assert.fail(`unhandled Docker operation ${JSON.stringify(args)}`);
  }

  async capture(args: string[], options: CaptureOptions): Promise<number> {
    if (args[0] === 'exec') {
      const target = [...this.containers.values()].find((c) => c.Id === args[1]);
      assert.ok(target?.running, 'exec requires a running container');
      const argv = args.slice(args.indexOf('oms-exec') + 2);
      this.execs.push({ container: target, argv });
      if (this.onExec) return this.onExec(target, argv, options);
      options.stdout(Buffer.from('captured output'));
      return 0;
    }
    const container = [...this.containers.values()].find((c) => c.Id === args.at(-1));
    assert.ok(container);
    this.executions.push(container);
    if (this.onExecute) return this.onExecute(container, options);
    options.stdout(Buffer.from('captured output'));
    return 0;
  }
}

export function abortable(options: CaptureOptions): Promise<number> {
  return new Promise((resolve) => {
    if (options.signal.aborted) resolve(130);
    else options.signal.addEventListener('abort', () => resolve(130), { once: true });
  });
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
