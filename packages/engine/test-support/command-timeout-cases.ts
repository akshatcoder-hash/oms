import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { SandboxExecOptions, SandboxSessionOptions } from '@oms/sandbox';
import * as sandbox from '@oms/sandbox';

const runs: Array<SandboxExecOptions & { argv: string[] }> = [];
mock.module('@oms/sandbox', { namedExports: {
  ...sandbox,
  createSandboxSession: (_options: SandboxSessionOptions) => ({
    exec: async (argv: string[], options: SandboxExecOptions) => {
      runs.push({ ...options, argv });
      return { exitCode: 0, stdout: 'done\n', stderr: '', timedOut: false, cancelled: false, truncated: false };
    },
    close: async () => {},
  }),
} });
const { createSandboxTools } = await import('../src/runtime/sandbox-tools.ts');
const { dockerBackend } = await import('../src/runtime/execution-backend.ts');

function fixture(remaining: () => number) {
  return createSandboxTools({
    taskName: 'timeout-cases',
    mounts: { projectMount: { hostPath: '/unused', containerPath: '/work', mode: 'rw' },
      extraMounts: [], readOnlyMounts: [], volumes: [], shadowMounts: [] },
    backend: dockerBackend({ image: 'unused', forwarderImage: 'unused' }),
    leaseDir: '/unused', sourceControlDir: '/unused', surfnetPort: 8899,
    signal: new AbortController().signal, remainingWallClockMs: remaining,
  });
}

for (const [requested, remaining, expected] of [
  [600_000, 900_000, 600_000],
  [600_000, 100_000, 100_000],
  [undefined, 900_000, 60_000],
  [undefined, 10_000, 10_000],
] as const) {
  test(`execute(${requested}, remaining=${remaining}) forwards ${expected} ms`, async () => {
    const tools = fixture(() => remaining);
    try {
      await tools.execute(['true'], undefined, requested);
      assert.equal(runs.at(-1)!.timeoutMs, expected);
    } finally { await tools.dispose(); }
  });
}

for (const remaining of [0, -1]) {
  test(`remaining=${remaining} refuses before sandbox execution`, async () => {
    const tools = fixture(() => remaining);
    const before = runs.length;
    try {
      await assert.rejects(tools.execute(['true']), /wall-clock budget exhausted/i);
      assert.equal(runs.length, before);
    } finally { await tools.dispose(); }
  });
}

test('queued commands sample remaining wall time when they execute', async () => {
  let remaining = 900_000;
  const tools = fixture(() => remaining);
  try {
    const command = tools.execute(['true'], undefined, 600_000);
    remaining = 50_000;
    await command;
    assert.equal(runs.at(-1)!.timeoutMs, 50_000);
  } finally { await tools.dispose(); }
});

test('production user_bash adapter converts requested seconds and preserves default', async () => {
  const tools = fixture(() => 900_000);
  let shell: { exec: (command: string, cwd: string, request: {
    timeout?: number; onData: (bytes: Buffer) => void;
  }) => Promise<unknown> } | undefined;
  try {
    await tools.extension({
      registerTool() {},
      on(event: string, handler: () => { operations: typeof shell }) {
        if (event === 'user_bash') shell = handler().operations;
      },
    } as unknown as ExtensionAPI);
    assert.ok(shell);
    await shell.exec('true', '/work', { timeout: 600, onData() {} });
    assert.equal(runs.at(-1)!.timeoutMs, 600_000);
    await shell.exec('true', '/work', { onData() {} });
    assert.equal(runs.at(-1)!.timeoutMs, 60_000);
  } finally { await tools.dispose(); }
});
