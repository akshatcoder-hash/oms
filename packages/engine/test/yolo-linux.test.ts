import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { hostSandbox } from '@oms/sandbox';
import { hostBackend } from '../src/runtime/execution-backend.ts';
import { createSandboxTools } from '../src/runtime/sandbox-tools.ts';

// A host with no Seatbelt is where YOLO changes nothing about confinement and only decides whether commands ask first.
function withoutSeatbelt(t: TestContext) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  assert.equal(hostSandbox(), 'none');
}

function chatTools(t: TestContext, yolo: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oms-yolo-linux-')));
  const control = mkdtempSync(join(tmpdir(), 'oms-yolo-linux-control-'));
  const tools = createSandboxTools({
    backend: hostBackend(),
    taskName: 'yolo-linux',
    mounts: {
      projectMount: { hostPath: root, containerPath: '/work', mode: 'rw' },
      extraMounts: [],
      readOnlyMounts: [],
      volumes: [],
      shadowMounts: [],
    },
    leaseDir: root,
    sourceControlDir: control,
    surfnetPort: 8899,
    signal: new AbortController().signal,
    hostTrust: { yolo, allowed: new Set() },
  });
  let asked = 0;
  tools.setHostApproval(async () => {
    asked++;
    return true;
  });
  t.after(async () => {
    await tools.dispose();
    rmSync(root, { recursive: true, force: true });
    rmSync(control, { recursive: true, force: true });
  });
  return { tools, asked: () => asked };
}

test('on a host without Seatbelt, YOLO runs a command without asking', async (t) => {
  withoutSeatbelt(t);
  const { tools, asked } = chatTools(t, true);
  const result = await tools.execute(['/bin/sh', '-c', 'printf ran']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'ran');
  assert.equal(asked(), 0);
});

test('on a host without Seatbelt, a command asks first unless YOLO is on', async (t) => {
  withoutSeatbelt(t);
  const { tools, asked } = chatTools(t, false);
  const result = await tools.execute(['/bin/sh', '-c', 'printf ran']);
  assert.equal(result.stdout, 'ran');
  assert.equal(asked(), 1);
});
