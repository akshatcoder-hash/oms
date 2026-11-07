import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const cases = [
  ['sandbox/test/integration.test.ts', '^token/signer dir is unreadable from the run phase', ['DOCKER']],
  ['surfnet/test/surfnet.integration.test.ts', '^start produces a healthy offline surfnet', ['SURFPOOL']],
  ['engine/test/task-terminal.integration.test.ts', '^actual owned DockerTTY', ['DOCKER']],
  ['engine/test/task-files.test.ts', '^shared file access preserves bytes', ['DOCKER']],
  ['engine/test/workspace-recovery.test.ts', '^dead owner with no resources', ['DOCKER']],
  ['engine/test/runtime-session.test.ts', '^interactive prompts survive idle lifetime', ['DOCKER', 'SURFPOOL']],
  ['engine/test/task-terminal-session.test.ts', '^one session shares editor', ['DOCKER', 'SURFPOOL']],
  ['engine/test/verifier-backend.test.ts', '^real offline verifier closes', ['DOCKER', 'SURFPOOL']],
  ['cli/test/interface.integration.test.ts', '^OMS interface drives real sandbox edits', ['DOCKER', 'SURFPOOL']],
  ['cli/test/workbench.integration.test.ts', '^one application edits files', ['DOCKER', 'SURFPOOL']],
] as const;

function run(file: string, pattern: string, unavailable?: string, flag?: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OMS_REQUIRE_DOCKER: '0',
    OMS_REQUIRE_SURFPOOL: '0',
    ...(unavailable === 'DOCKER' ? { DOCKER_HOST: 'unix:///tmp/oms-deliberately-missing-docker.sock' } : {}),
    ...(unavailable === 'SURFPOOL' ? { SURFPOOL_BINARY: '/oms-deliberately-missing/surfpool' } : {}),
    ...(flag ? { [`OMS_REQUIRE_${flag}`]: '1' } : {}),
  };
  // This is an independent test runner, not a recursive node:test invocation.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    '--test', '--test-reporter=tap', '--test-timeout=20000',
    `--test-name-pattern=${pattern}`, `packages/${file}`,
  ], { cwd: root, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stdout + result.stderr);
  return { status: result.status, tap: result.stdout + result.stderr };
}

for (const [file, pattern, flags] of cases) {
  for (const flag of flags) {
    test(`${file}: optional unavailable ${flag} still skips`, () => {
      const result = run(file, pattern, flag);
      assert.equal(result.status, 0, result.tap);
      assert.match(result.tap, /^# fail 0$/m);
      assert.match(result.tap, /^# skipped 1$/m);
    });
    test(`${file}: OMS_REQUIRE_${flag}=1 fails instead of skipping`, () => {
      const result = run(file, pattern, flag, flag);
      assert.notEqual(result.status, 0, result.tap);
      assert.match(result.tap, /^# fail [1-9]\d*$/m);
      assert.match(result.tap, /^# skipped 0$/m);
      assert.match(result.tap, new RegExp(`OMS_REQUIRE_${flag}=1`));
    });
  }
}

for (const [file, pattern] of cases.slice(0, 2)) {
  test(`${file}: present infrastructure executes without skips`, t => {
    if (!process.env.OMS_SANDBOX_IMAGE || !process.env.OMS_SANDBOX_FORWARDER_IMAGE || !process.env.SURFPOOL_BINARY) {
      return t.skip('set the approved integration environment for the present-infrastructure proof');
    }
    const result = run(file, pattern);
    assert.equal(result.status, 0, result.tap);
    assert.match(result.tap, /^# pass [1-9]\d*$/m);
    assert.match(result.tap, /^# fail 0$/m);
    assert.match(result.tap, /^# skipped 0$/m);
  });
}
