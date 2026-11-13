import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_OPTIONS, renderText, runChecks, summarize, type Env } from "../src/doctor/checks.ts";

function fakeEnv(over: Partial<Env> & { tools?: Record<string, string> } = {}): Env {
  const tools = over.tools ?? {
    surfpool: "surfpool 1.7.0",
    solana: "solana-cli 4.3.2",
    docker: "29.5.2",
  };
  return {
    platform: "darwin",
    nodeVersion: "22.22.3",
    env: { ANTHROPIC_API_KEY: "sk-test-not-a-real-key" },
    freeDiskGb: async () => 50,
    exec: async (bin) => {
      const out = tools[bin];
      return out === undefined ? { ok: false, out: "not installed" } : { ok: true, out };
    },
    rpcHealth: async () => ({ ok: true, out: '"ok"' }),
    ...over,
  };
}

test("all good: exit 0, no blocking", async () => {
  const results = await runChecks(fakeEnv(), DEFAULT_OPTIONS);
  const s = summarize(results);
  assert.equal(s.exitCode, 0);
  assert.equal(s.blocking, 0);
});

test("missing surfpool is blocking and prints a fix", async () => {
  const env = fakeEnv({ tools: { solana: "x", docker: "1" } });
  const results = await runChecks(env, DEFAULT_OPTIONS);
  assert.equal(summarize(results).exitCode, 1);
  assert.match(renderText(results), /fix: Run: oms doctor --install .*surfpool 1\.7\.0.*--surfpool-binary/);
});

test("wrong surfpool version fails against the pin", async () => {
  const env = fakeEnv({ tools: { surfpool: "surfpool 1.6.0", solana: "x", docker: "1" } });
  const r = (await runChecks(env, DEFAULT_OPTIONS)).find((c) => c.id === "surfpool");
  assert.equal(r?.status, "fail");
});

test("low disk is blocking", async () => {
  const results = await runChecks(fakeEnv({ freeDiskGb: async () => 4.2 }), DEFAULT_OPTIONS);
  const disk = results.find((c) => c.id === "disk");
  assert.equal(disk?.status, "fail");
  assert.equal(summarize(results).exitCode, 1);
});

test("anchor missing on host is informational unless programs are needed", async () => {
  const base = await runChecks(fakeEnv(), DEFAULT_OPTIONS);
  assert.equal(summarize(base).exitCode, 0);
  const strict = await runChecks(fakeEnv(), { ...DEFAULT_OPTIONS, needsPrograms: true });
  assert.equal(summarize(strict).exitCode, 1);
});

test("missing model key is a warning, not blocking, and never echoes a value", async () => {
  const noKey = await runChecks(fakeEnv({ env: {} }), DEFAULT_OPTIONS);
  assert.equal(summarize(noKey).exitCode, 0);
  assert.equal(summarize(noKey).warnings, 1);
  const withKey = JSON.stringify(await runChecks(fakeEnv(), DEFAULT_OPTIONS));
  assert.ok(!withKey.includes("sk-test-not-a-real-key"));
});

test("surfnet rpc is checked only when a url is given", async () => {
  const none = await runChecks(fakeEnv(), DEFAULT_OPTIONS);
  assert.ok(!none.some((c) => c.id === "surfnet-rpc"));
  const down = await runChecks(fakeEnv({ rpcHealth: async () => ({ ok: false, out: "unreachable" }) }), {
    ...DEFAULT_OPTIONS,
    surfnetRpcUrl: "http://127.0.0.1:1",
  });
  assert.equal(down.find((c) => c.id === "surfnet-rpc")?.status, "fail");
});

test("old node is blocking", async () => {
  const results = await runChecks(fakeEnv({ nodeVersion: "20.1.0" }), DEFAULT_OPTIONS);
  assert.equal(results.find((c) => c.id === "node")?.status, "fail");
});

test("a Node release below the pinned SDK minor floor is blocking", async () => {
  const result = await runChecks(fakeEnv({ nodeVersion: "22.18.0" }), DEFAULT_OPTIONS);
  assert.equal(result.find(check => check.id === "node")?.status, "fail");
});

test("a different Surfpool version cannot satisfy the pin by substring", async () => {
  const result = await runChecks(fakeEnv({ tools: { surfpool: "surfpool 11.7.0", solana: "x", docker: "1" } }), DEFAULT_OPTIONS);
  assert.equal(result.find(check => check.id === "surfpool")?.status, "fail");
});

test("project-local Surfpool and a missing approved image have distinct readiness results", async () => {
  const env = fakeEnv({ tools: { "/approved/surfpool": "surfpool 1.7.0", solana: "x", docker: "1" } });
  const execute = env.exec;
  env.exec = async (bin, args) => args[0] === "image" ? { ok: false, out: "image is not cached" } : execute(bin, args);
  const result = await runChecks(env, { ...DEFAULT_OPTIONS, surfpoolBinary: "/approved/surfpool", sandboxImage: "node@sha256:" + "a".repeat(64) });
  assert.equal(result.find(check => check.id === "surfpool")?.status, "ok");
  assert.equal(result.find(check => check.id === "sandbox-image")?.severity, "blocking");
  assert.equal(result.find(check => check.id === "sandbox-image")?.status, "fail");
});

test('host doctor succeeds without Docker and reports active backend', async () => {
  const env = fakeEnv({ tools: { surfpool: 'surfpool 1.7.0', solana: 'solana-cli fixture' } });
  const calls: string[] = [];
  const original = env.exec;
  env.exec = async (bin, args) => { calls.push(bin); return original(bin, args); };
  const results = await runChecks(env, { ...DEFAULT_OPTIONS, backend: 'host' });
  assert.equal(summarize(results).exitCode, 0);
  assert.match(results.find(value => value.id === 'backend')!.detail, /host.*no sandbox/);
  const text = renderText(results);
  assert.match(text, /Optional \(benchmark \/ --sandbox docker\)\n {2}Docker/);
  assert.doesNotMatch(text.slice(0, text.indexOf('Optional')), /Docker/);
  assert.equal(summarize(await runChecks(env, { ...DEFAULT_OPTIONS, backend: 'docker' })).exitCode, 1);
});

test('host doctor on macOS reports Seatbelt only when sandbox-exec runs', async () => {
  const env = fakeEnv({ tools: { surfpool: 'surfpool 1.7.0', solana: 'x', 'sandbox-exec': '' } });
  assert.match((await runChecks(env, { ...DEFAULT_OPTIONS, backend: 'host' })).find(value => value.id === 'backend')!.detail, /Seatbelt/);
  env.platform = 'linux';
  assert.match((await runChecks(env, { ...DEFAULT_OPTIONS, backend: 'host' })).find(value => value.id === 'backend')!.detail, /no sandbox/);
});
