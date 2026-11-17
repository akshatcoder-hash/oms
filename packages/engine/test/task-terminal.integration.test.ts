import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildMounts, dockerOut } from '@oms/sandbox';
import { acquireSourceAccess } from '@oms/contract';
import { createTaskTerminal, type OwnedTaskTerminal, type TaskTerminalOptions } from '../src/runtime/task-terminal.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

const IMAGE = process.env.OMS_SANDBOX_IMAGE;
const FORWARDER = process.env.OMS_SANDBOX_FORWARDER_IMAGE;

test(
  'actual owned DockerTTY streams VT, execs in the same source, resizes, accepts Unicode and Ctrl-C, then releases ownership',
  { timeout: 120_000 },
  async (t) => {
    if ((await skipUnavailable(t, { docker: [IMAGE, FORWARDER] })) || !IMAGE || !FORWARDER) return;
    const root = path.resolve(import.meta.dirname, '../.tmp');
    mkdirSync(root, { recursive: true });
    const base = mkdtempSync(path.join(root, 'terminal-'));
    const project = path.join(base, 'project');
    const state = path.join(base, 'state');
    const signer = path.join(base, 'signer');
    for (const dir of [project, state, signer]) mkdirSync(dir);
    writeFileSync(path.join(project, 'file.txt'), 'original');
    const sourceControlDir = path.join(base, 'source-control');
    const taskName = `r01-terminal-${process.pid}`;
    let frameGeneration = 0;
    let wakeFrame = () => {};
    const output = new WeakMap<OwnedTaskTerminal, string>();
    const options: TaskTerminalOptions = {
      run: {
        backend: 'docker',
        taskName,
        phase: 'run',
        surfnet: { port: 9 },
        argv: [
          'sh',
          '-c',
          String.raw`test -t 0 && test -t 1 || exit 91; trap "printf '\nINTERRUPTED\n'; exit 0" INT; printf "\033[2J\033[HREADY\n"; while IFS= read -r value; do printf "INPUT:%s\n" "$value"; done`,
        ],
        image: IMAGE,
        forwarderImage: FORWARDER,
        timeoutMs: 90_000,
        leaseDir: path.join(base, 'leases'),
        sourceControlDir,
        mounts: buildMounts({ projectRoot: project, taskName, forbidden: { signerDir: signer, stateDir: state } }),
      },
      columns: 50,
      rows: 10,
    };
    async function observedTerminal() {
      const created = await createTaskTerminal(options);
      output.set(created, '');
      created.subscribe((bytes) => {
        output.set(created, (output.get(created)! + Buffer.from(bytes).toString('utf8')).slice(-32_768));
        frameGeneration++;
        wakeFrame();
      });
      return created;
    }
    const terminal = await observedTerminal();
    async function bounded<T>(phase: string, operation: Promise<T>, target: OwnedTaskTerminal = terminal): Promise<T> {
      // Real Docker events cannot use a virtual clock; this is a failure deadline,
      // not a guessed sleep used to decide whether an operation succeeded.
      let timer!: NodeJS.Timeout;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${phase} timed out; output=${JSON.stringify(output.get(target)?.slice(-1500))}`)),
          10_000,
        );
      });
      try {
        return await Promise.race([operation, deadline]);
      } finally {
        clearTimeout(timer);
      }
    }
    async function until(text: string, target: OwnedTaskTerminal = terminal) {
      let stopped = false;
      const exited = target.exited.then((result) => {
        throw new Error(
          `waiting for ${JSON.stringify(text)}: terminal exited code=${result.exitCode} stderr=${JSON.stringify(result.stderr.slice(-1000))}`,
        );
      });
      void exited.catch(() => {});
      const observing = (async () => {
        while (!stopped) {
          const generation = frameGeneration;
          if (output.get(target)?.includes(text)) return;
          // Install before yielding, then detect any synchronous rendering event.
          // Never replace a resolver belonging to a promise already being awaited.
          const frame = new Promise<void>((resolve) => {
            wakeFrame = resolve;
          });
          if (generation !== frameGeneration) wakeFrame();
          await Promise.race([frame, exited]);
        }
      })();
      try {
        await bounded(`waiting for ${JSON.stringify(text)}`, observing, target);
      } finally {
        stopped = true;
        wakeFrame();
        wakeFrame = () => {};
      }
    }
    try {
      await until('READY');
      assert.match(output.get(terminal)!, /\x1b\[2J\x1b\[HREADY/);
      assert.throws(() => acquireSourceAccess(project, { sourceControlDir, kind: 'capture' }), /busy|active|source/i);
      const file = await terminal.execute([
        'node',
        '-e',
        'process.stdout.write(require("fs").readFileSync("/work/file.txt", "utf8"))',
      ]);
      assert.equal(file.stdout, 'original');
      terminal.resize(61, 13);
      const size = await terminal.execute(['sh', '-c', 'stty size < /proc/1/fd/0']);
      assert.equal(size.exitCode, 0);
      assert.match(size.stdout, /13 61/);
      terminal.write(Buffer.from('café界\r'));
      await until('INPUT:café界');
      terminal.write(Buffer.from('\x03'));
      const result = await bounded('Ctrl-C shell exit and owned teardown', terminal.exited);
      assert.equal(result.timedOut, false);
      assert.match(result.stdout, /INTERRUPTED/);
      await assert.rejects(terminal.execute(['true']), /clos|exit/i);
      await terminal.close();
      const release = acquireSourceAccess(project, { sourceControlDir, kind: 'capture' });
      release();
      const cancelledTerminal = await observedTerminal();
      try {
        await until('READY', cancelledTerminal);
        const cancellation = new AbortController();
        const pending = cancelledTerminal.execute(
          ['node', '-e', 'require("fs").writeFileSync("/proc/1/fd/1", "EXEC-START\\n");setInterval(()=>{},1000)'],
          cancellation.signal,
        );
        const refused = assert.rejects(pending, /cancelled.*terminal closed/i);
        await until('EXEC-START', cancelledTerminal);
        await assert.rejects(cancelledTerminal.execute(['true']), /active|busy/i);
        cancellation.abort();
        await refused;
        await assert.rejects(cancelledTerminal.execute(['true']), /clos|exit/i);
        const releasedAfterCancel = acquireSourceAccess(project, { sourceControlDir, kind: 'capture' });
        releasedAfterCancel();
      } finally {
        await cancelledTerminal.close();
      }
      assert.equal((await dockerOut(['ps', '-aq', '--filter', `label=oms.task=${taskName}`])).trim(), '');
    } finally {
      await terminal.close();
      rmSync(base, { recursive: true, force: true });
    }
  },
);
