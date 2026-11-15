import { execFile, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { acquireHostRun, hostArgv, hostEnvironment, type HostRunOptions, type SandboxResult } from '@oms/sandbox';
import { LatestResizeQueue, TerminalOutput, type OwnedTaskTerminal, type TaskTerminalOptions } from './task-terminal.ts';

/** A terminal on the host: the run options carry no image, lease or egress settings. */
export type HostTerminalOptions = Omit<TaskTerminalOptions, 'run'> & { run: HostRunOptions };

/** The platform script utility supplies a PTY without an npm/native dependency. */
export async function createHostTerminal(options: HostTerminalOptions): Promise<OwnedTaskTerminal> {
  const { home, cleanup } = acquireHostRun(options.run, realpathSync(options.run.mounts.projectMount.hostPath));
  try {
    const terminal = await startHostTerminal(options, home);
    const exited = terminal.exited.finally(cleanup);
    void exited.catch(() => {});
    return { ...terminal, exited, async close() { await terminal.close(); await exited; } };
  } catch (error) { cleanup(); throw error; }
}

async function startHostTerminal(options: HostTerminalOptions, home: string): Promise<OwnedTaskTerminal> {
  options.run.signal?.throwIfAborted();
  const env = hostEnvironment({ HOME: home, ...options.run.env, TERM: 'xterm-256color' });
  // BSD script(1) refuses a socket on stdin (tcgetattr fails), and Node gives children socket pairs on macOS, so a cat pipe
  // feeds it a real pipe there. Closing kills the whole process group, cat included.
  const [command, ...args] = hostArgv(options.run, realpathSync(options.run.mounts.projectMount.hostPath), home, env, process.platform === 'darwin'
    ? ['/bin/sh', '-c', 'cat | script -q /dev/null /bin/sh -i'] : ['script', '-qefc', '/bin/sh -i', '/dev/null']);
  const child = spawn(command!, args, { cwd: options.run.cwd ?? options.run.mounts.projectMount.hostPath,
    env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let closing = false, timedOut = false, cancelled = false;
  let failure: unknown;
  const kill = () => {
    closing = true;
    if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error; }
  };
  if (child.pid) try { options.run.onSpawn?.(child.pid, options.run.cwd ?? options.run.mounts.projectMount.hostPath); } catch (error) { failure = error; kill(); }
  const output = new TerminalOutput(error => { failure = error; kill(); });
  const cancel = () => { cancelled = true; output.close(); kill(); };
  options.run.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; output.close(); kill(); }, options.run.timeoutMs);
  const resizes = new LatestResizeQueue(async (columns, rows) => {
    const deadline = Date.now() + 2000;
    while (!closing) {
      const listing = await new Promise<string>((resolve, reject) => execFile('ps', ['-axo', 'pid=,ppid=,tty='],
        { env: hostEnvironment(), timeout: 2000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
      const records = listing.trim().split('\n').map(line => line.trim().split(/\s+/));
      const descendants = new Set<number>([child.pid!]);
      for (let pass = 0; pass < records.length; pass++) {
        let changed = false;
        for (const [pid, parent] of records) if (descendants.has(Number(parent)) && !descendants.has(Number(pid))) { descendants.add(Number(pid)); changed = true; }
        if (!changed) break;
      }
      const tty = records.find(([pid, , tty]) => descendants.has(Number(pid)) && /^(?:pts\/\d+|ttys\d+)$/.test(tty ?? ''))?.[2];
      if (tty) {
        if (closing) return;
        await new Promise<void>((resolve, reject) => execFile('/bin/stty', [process.platform === 'darwin' ? '-f' : '-F', `/dev/${tty}`, 'cols', String(columns), 'rows', String(rows)],
          { env: hostEnvironment(), timeout: 2000 }, error => error ? reject(error) : resolve()));
        return;
      }
      if (Date.now() >= deadline) throw new Error('Host terminal PTY was not acquired');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  });
  const read = async (stream: NodeJS.ReadableStream) => {
    for await (const chunk of stream) await output.write(Buffer.from(chunk));
  };
  const streams = Promise.all([read(child.stdout), read(child.stderr)]);
  void streams.catch(error => { failure = error; kill(); });
  child.stdin.on('error', error => { if (!closing) { failure = error; kill(); } });
  const exited = new Promise<SandboxResult>((resolve, reject) => {
    child.once('error', error => { failure = error; });
    child.once('exit', kill);
    child.once('close', async code => {
      clearTimeout(timer);
      options.run.signal?.removeEventListener('abort', cancel);
      output.close();
      try {
        await Promise.all([streams, resizes.close()]);
        if (failure) throw failure;
        resolve({ exitCode: timedOut ? 124 : cancelled ? 130 : code ?? 127,
          stdout: '', stderr: '', truncated: false, timedOut, cancelled });
      } catch (error) { reject(error); }
    });
  });
  // Observe before returning so a failed utility spawn cannot leak a rejection.
  void exited.catch(() => {});
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  if (options.run.signal?.aborted) cancel();
  try { resizes.resize(options.columns, options.rows); await resizes.idle(); }
  catch (error) { cancel(); await exited; throw error; }
  return {
    write(data) {
      if (closing) throw new Error('host terminal is closed');
      if (data.byteLength + child.stdin.writableLength > 64 * 1024) throw new Error('terminal pending input limit exceeded');
      child.stdin.write(data);
    },
    resize(columns, rows) {
      if (closing) throw new Error('host terminal is closed');
      if (![columns, rows].every(n => Number.isInteger(n) && n > 0 && n <= 500)) throw new Error('invalid terminal dimensions');
      resizes.resize(columns, rows);
    },
    subscribe: listener => output.subscribe(listener), exited,
    execute(argv, signal, timeoutMs = 10_000, onOutput) {
      if (closing) return Promise.reject(new Error('host terminal is closed'));
      return Promise.reject(new Error('Stop the host terminal before running task tools'));
    },
    async close() { cancel(); await exited; },
  };
}
