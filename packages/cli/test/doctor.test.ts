import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_OPTIONS, renderText, runChecks, summarize, type Env } from '../src/doctor/checks.ts';

function fakeEnv(over: Partial<Env> & { tools?: Record<string, string> } = {}): Env {
  const tools = over.tools ?? {
    surfpool: 'surfpool 1.7.0',
    solana: 'solana-cli 4.3.2',
    docker: '29.5.2',
  };
  return {
    platform: 'darwin',
    nodeVersion: '22.22.3',
    env: { ANTHROPIC_API_KEY: 'sk-test-not-a-real-key' },
    freeDiskGb: async () => 50,
    exec: async (bin) => {
      const out = tools[bin];
      return out === undefined ? { ok: false, out: 'not installed' } : { ok: true, out };
    },
    rpcHealth: async () => ({ ok: true, out: '"ok"' }),
    ...over,
  };
}

test('all good: exit 0, no blocking', async () => {
  const results = await runChecks(fakeEnv(), DEFAULT_OPTIONS);
  const s = summarize(results);
  assert.equal(s.exitCode, 0);
  assert.equal(s.blocking, 0);
});

test('model access status uses complete sentences without claiming login was checked', async () => {
  for (const [environment, detail, status] of [
    [{}, 'No provider environment is configured. Saved subscription login has not been checked.', 'fail'],
    [{ OPENAI_API_KEY: 'fixture' }, 'A provider environment is configured. Login has not been validated.', 'ok'],
  ] as const) {
    const results = await runChecks(fakeEnv({ env: environment }), DEFAULT_OPTIONS);
    const model = results.find((result) => result.id === 'model-key');
    assert.equal(model?.detail, detail);
    assert.equal(model?.status, status);
    assert.equal(model?.severity, 'warning');
    assert.equal(summarize(results).exitCode, 0);
    assert.ok(renderText(results).includes(detail));
  }
});

test('blocking summaries use complete sentences with the exact issue count', async () => {
  for (const [tools, count, sentence] of [
    [{ surfpool: 'surfpool 1.7.0' }, 1, '1 blocking issue needs attention.'],
    [{}, 2, '2 blocking issues need attention.'],
  ] as const) {
    const results = await runChecks(fakeEnv({ nodeVersion: '20.1.0', tools }), DEFAULT_OPTIONS);
    assert.equal(summarize(results).blocking, count);
    assert.equal(summarize(results).exitCode, 1);
    assert.ok(renderText(results).endsWith(`oms doctor: ${sentence}`));
  }
  assert.equal(renderText([], {}), 'oms doctor: ready. Run `oms` to launch OMS.');
});

test('ready doctor prints the launch command for its invocation environment', async () => {
  for (const [environment, command] of [
    [{}, 'oms'],
    [{ npm_command: 'exec' }, 'npx @barestate/oms'],
  ] as const) {
    const results = await runChecks(fakeEnv({ env: environment }), DEFAULT_OPTIONS);
    assert.ok(renderText(results, environment).endsWith(`oms doctor: ready. Run \`${command}\` to launch OMS.`));
    assert.ok(renderText([], environment).endsWith(`oms doctor: ready. Run \`${command}\` to launch OMS.`));
    const blocked = await runChecks(fakeEnv({ env: environment, nodeVersion: '20.1.0' }), DEFAULT_OPTIONS);
    assert.doesNotMatch(renderText(blocked, environment), /to launch OMS/);
    assert.equal(summarize(blocked).exitCode, 1);
  }
});

test('missing Solana CLI warns for chat and blocks program readiness checks', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    for (const needsPrograms of [false, true]) {
      const results = await runChecks(
        fakeEnv({ platform, tools: { surfpool: 'surfpool 1.7.0', docker: '1', anchor: 'anchor-cli 0.32.1' } }),
        { ...DEFAULT_OPTIONS, needsPrograms },
      );
      const solana = results.find((check) => check.id === 'solana');
      assert.equal(solana?.status, 'fail');
      assert.equal(solana?.severity, needsPrograms ? 'blocking' : 'warning');
      assert.equal(solana?.detail, 'The Solana CLI is needed to build and deploy programs.');
      assert.equal(
        solana?.fix,
        platform === 'darwin'
          ? 'Run `brew install solana`.'
          : 'See https://solana.com/docs/intro/installation for installation instructions.',
      );
      assert.deepEqual(
        summarize(results),
        needsPrograms ? { blocking: 1, warnings: 0, exitCode: 1 } : { blocking: 0, warnings: 1, exitCode: 0 },
      );
      assert.match(renderText(results), needsPrograms ? /Blocking\n {2}Solana CLI/ : /Warnings\n {2}Solana CLI/);
      assert.match(
        renderText(results),
        needsPrograms
          ? /oms doctor: 1 blocking issue needs attention\.$/
          : /oms doctor: ready\. Run `oms` to launch OMS\.$/,
      );
    }
  }
});

test('a broken Solana CLI preserves its diagnostic and blocks only program readiness', async () => {
  for (const diagnostic of ['Permission denied', 'Failed to load shared library', '']) {
    for (const needsPrograms of [false, true]) {
      const env = fakeEnv({ tools: { surfpool: 'surfpool 1.7.0', docker: '1', anchor: 'anchor-cli 0.32.1' } });
      const execute = env.exec;
      env.exec = async (bin, args) => (bin === 'solana' ? { ok: false, out: diagnostic } : execute(bin, args));
      const results = await runChecks(env, { ...DEFAULT_OPTIONS, needsPrograms });
      const solana = results.find((check) => check.id === 'solana');
      assert.equal(solana?.status, 'fail');
      assert.equal(solana?.severity, needsPrograms ? 'blocking' : 'warning');
      assert.equal(
        solana?.detail,
        `${diagnostic ? `${diagnostic} ` : ''}The Solana CLI is needed to build and deploy programs.`,
      );
      assert.equal(summarize(results).exitCode, needsPrograms ? 1 : 0);
      assert.ok(renderText(results).includes(solana!.detail));
    }
  }
});

test('a missing Solana CLI does not downgrade other blocking failures', async () => {
  const results = await runChecks(
    fakeEnv({ nodeVersion: '20.1.0', tools: { surfpool: 'surfpool 1.7.0', docker: '1' } }),
    DEFAULT_OPTIONS,
  );
  assert.deepEqual(summarize(results), { blocking: 1, warnings: 1, exitCode: 1 });
  assert.equal(results.find((check) => check.id === 'node')?.severity, 'blocking');
});

test('missing surfpool is blocking and prints a fix', async () => {
  const env = fakeEnv({ tools: { solana: 'x', docker: '1' } });
  const results = await runChecks(env, DEFAULT_OPTIONS);
  assert.equal(summarize(results).exitCode, 1);
  assert.match(renderText(results), /fix: Run `oms doctor --install` .*Surfpool 1\.7\.0.*--surfpool-binary/);
});

test('missing surfpool tells npx users how to install or select it', async () => {
  const results = await runChecks(fakeEnv({ tools: {}, env: { npm_command: 'exec' } }), DEFAULT_OPTIONS);
  const fix = results.find((result) => result.id === 'surfpool')?.fix;
  assert.equal(
    fix,
    'Run `npx @barestate/oms doctor --install` to download Surfpool 1.7.0 and verify its SHA-256. Or install it yourself and run `npx @barestate/oms doctor --surfpool-binary /absolute/path/to/surfpool`.',
  );
});

test('wrong surfpool version fails against the pin', async () => {
  const env = fakeEnv({ tools: { surfpool: 'surfpool 1.6.0', solana: 'x', docker: '1' } });
  const r = (await runChecks(env, DEFAULT_OPTIONS)).find((c) => c.id === 'surfpool');
  assert.equal(r?.status, 'fail');
});

test('low disk warns above 1 GB and blocks below it', async () => {
  const at = async (gb: number) =>
    (await runChecks(fakeEnv({ freeDiskGb: async () => gb }), DEFAULT_OPTIONS)).find((c) => c.id === 'disk');
  const low = await at(4.2);
  assert.equal(
    summarize(await runChecks(fakeEnv({ freeDiskGb: async () => 4.2 }), DEFAULT_OPTIONS)).exitCode,
    0,
    'a warning does not block',
  );
  assert.equal(summarize(await runChecks(fakeEnv({ freeDiskGb: async () => 0.6 }), DEFAULT_OPTIONS)).exitCode, 1);
  assert.equal(low?.status, 'fail');
  assert.equal(low?.severity, 'warning');
  assert.match(low?.detail ?? '', /OMS runs, but Anchor\/Rust builds and --sandbox docker may need up to 5 GB/);
  const empty = await at(0.6);
  assert.equal(empty?.severity, 'blocking');
  assert.equal((await at(50))?.status, 'ok');
});

test('anchor missing on host is informational unless programs are needed', async () => {
  const base = await runChecks(fakeEnv(), DEFAULT_OPTIONS);
  assert.equal(summarize(base).exitCode, 0);
  const strict = await runChecks(fakeEnv(), { ...DEFAULT_OPTIONS, needsPrograms: true });
  assert.equal(summarize(strict).exitCode, 1);
});

test('missing model key is a warning, not blocking, and never echoes a value', async () => {
  const noKey = await runChecks(fakeEnv({ env: {} }), DEFAULT_OPTIONS);
  assert.equal(summarize(noKey).exitCode, 0);
  assert.equal(summarize(noKey).warnings, 1);
  const withKey = JSON.stringify(await runChecks(fakeEnv(), DEFAULT_OPTIONS));
  assert.ok(!withKey.includes('sk-test-not-a-real-key'));
});

test('surfnet rpc is checked only when a url is given', async () => {
  const none = await runChecks(fakeEnv(), DEFAULT_OPTIONS);
  assert.ok(!none.some((c) => c.id === 'surfnet-rpc'));
  const down = await runChecks(fakeEnv({ rpcHealth: async () => ({ ok: false, out: 'unreachable' }) }), {
    ...DEFAULT_OPTIONS,
    surfnetRpcUrl: 'http://127.0.0.1:1',
  });
  assert.equal(down.find((c) => c.id === 'surfnet-rpc')?.status, 'fail');
});

test('old node is blocking', async () => {
  const results = await runChecks(fakeEnv({ nodeVersion: '20.1.0' }), DEFAULT_OPTIONS);
  assert.equal(results.find((c) => c.id === 'node')?.status, 'fail');
});

test('a Node release below the pinned SDK minor floor is blocking', async () => {
  const result = await runChecks(fakeEnv({ nodeVersion: '22.18.0' }), DEFAULT_OPTIONS);
  assert.equal(result.find((check) => check.id === 'node')?.status, 'fail');
});

test('a different Surfpool version cannot satisfy the pin by substring', async () => {
  const result = await runChecks(
    fakeEnv({ tools: { surfpool: 'surfpool 11.7.0', solana: 'x', docker: '1' } }),
    DEFAULT_OPTIONS,
  );
  assert.equal(result.find((check) => check.id === 'surfpool')?.status, 'fail');
});

test('project-local Surfpool and a missing approved image have distinct readiness results', async () => {
  const env = fakeEnv({ tools: { '/approved/surfpool': 'surfpool 1.7.0', solana: 'x', docker: '1' } });
  const execute = env.exec;
  env.exec = async (bin, args) =>
    args[0] === 'image' ? { ok: false, out: 'image is not cached' } : execute(bin, args);
  const result = await runChecks(env, {
    ...DEFAULT_OPTIONS,
    surfpoolBinary: '/approved/surfpool',
    sandboxImage: 'node@sha256:' + 'a'.repeat(64),
  });
  assert.equal(result.find((check) => check.id === 'surfpool')?.status, 'ok');
  assert.equal(result.find((check) => check.id === 'sandbox-image')?.severity, 'blocking');
  assert.equal(result.find((check) => check.id === 'sandbox-image')?.status, 'fail');
});

test('host doctor succeeds without Docker and reports active backend', async () => {
  const env = fakeEnv({ tools: { surfpool: 'surfpool 1.7.0', solana: 'solana-cli fixture' } });
  const calls: string[] = [];
  const original = env.exec;
  env.exec = async (bin, args) => {
    calls.push(bin);
    return original(bin, args);
  };
  const results = await runChecks(env, { ...DEFAULT_OPTIONS, backend: 'host' });
  assert.equal(summarize(results).exitCode, 0);
  assert.match(results.find((value) => value.id === 'backend')!.detail, /host.*no sandbox/);
  const text = renderText(results);
  assert.match(text, /Optional \(benchmark \/ --sandbox docker\)\n {2}Docker/);
  assert.doesNotMatch(text.slice(0, text.indexOf('Optional')), /Docker/);
  assert.equal(summarize(await runChecks(env, { ...DEFAULT_OPTIONS, backend: 'docker' })).exitCode, 1);
});

test('host doctor on macOS reports Seatbelt only when sandbox-exec runs', async () => {
  const env = fakeEnv({ tools: { surfpool: 'surfpool 1.7.0', solana: 'x', 'sandbox-exec': '' } });
  assert.match(
    (await runChecks(env, { ...DEFAULT_OPTIONS, backend: 'host' })).find((value) => value.id === 'backend')!.detail,
    /Seatbelt/,
  );
  env.platform = 'linux';
  assert.match(
    (await runChecks(env, { ...DEFAULT_OPTIONS, backend: 'host' })).find((value) => value.id === 'backend')!.detail,
    /no sandbox/,
  );
});
