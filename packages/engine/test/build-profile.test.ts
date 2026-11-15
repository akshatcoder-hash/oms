import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('trusted build profile clamps timeout and supplies resources and offline Cargo home', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import * as sandbox from '@oms/sandbox';
    const runs = [];
    let session;
    const result = {exitCode:0,stdout:'',stderr:'',truncated:false,timedOut:false,cancelled:false};
    mock.module('@oms/sandbox', { namedExports: { ...sandbox,
      createSandboxSession: o => { session = o; return { exec: async (argv, o) => { runs.push({ ...o, argv }); return result; }, close: async () => {} }; },
      runInSandbox: async o => { runs.push(o); return result; } } });
    const { createSandboxTools } = await import('./packages/engine/src/runtime/sandbox-tools.ts');
    const { dockerBackend } = await import('./packages/engine/src/runtime/execution-backend.ts');
    let remaining = 2_000_000;
    const tools = createSandboxTools({taskName:'build-profile', backend:dockerBackend({image:'unused',forwarderImage:'unused'}),
      mounts:{projectMount:{hostPath:'/unused',containerPath:'/work',mode:'rw'},extraMounts:[],readOnlyMounts:[],volumes:[],shadowMounts:[]},
      leaseDir:'/unused',sourceControlDir:'/unused',surfnetPort:8899,signal:new AbortController().signal,
      buildProfile:true,remainingWallClockMs:()=>remaining});
    try {
      await tools.execute(['true']);
      assert.equal(runs.at(-1).timeoutMs,900_000);
      assert.deepEqual(session.limits,{memoryMb:6144,cpus:4,pidsLimit:1024});
      assert.equal(session.env.CARGO_HOME,'/work/.oms-cargo');
      assert.equal(session.env.CARGO_NET_OFFLINE,'true');
      await tools.execute(['true'],undefined,1_800_000);
      assert.equal(runs.at(-1).timeoutMs,900_000);
      remaining = 120_000;
      await tools.execute(['true']);
      assert.equal(runs.at(-1).timeoutMs,120_000);
      const registered = new Map();
      tools.extension({registerTool: t => registered.set(t.name,t),on(){}});
      await registered.get('deps_fetch').execute('fetch',{manager:'cargo'});
      const fetch = runs.at(-1);
      assert.equal(fetch.phase,'install');
      assert.deepEqual(fetch.installAllowlist,['index.crates.io:443','static.crates.io:443','registry.npmjs.org:443']);
      assert.equal(fetch.env.CARGO_NET_OFFLINE,undefined);
      assert.equal(fetch.timeoutMs,120_000);
    } finally { await tools.dispose(); }
  `,
    ],
    { cwd: new URL('../../../', import.meta.url), encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
