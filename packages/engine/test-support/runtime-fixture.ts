import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createFauxCore } from '@earendil-works/pi-ai';
import { createTask, openWorkspace } from '../src/workspace/index.ts';
import { prepareHarnessTask, type HarnessEnvironment } from '../src/runtime/session.ts';
import { defaultHarnessEnvironment } from '../src/runtime/environment.ts';

/** Real repository/task/runtime setup; only provider responses are controlled. */
export async function createHarnessFixture(environment: HarnessEnvironment) {
  // Callers that predate host mode are Docker fixtures; host fixtures pass backend: 'host'.
  environment = { ...defaultHarnessEnvironment(environment.binary, 'docker'), ...environment };
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oms-session-integration-')));
  const repo = join(base, 'repo');
  const stateRoot = join(base, 'state');
  const extensionSentinel = join(base, 'untrusted-extension-executed');
  mkdirSync(repo, { mode: 0o700 });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: base, GIT_CONFIG_NOSYSTEM: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q');
  git('config', 'user.name', 'OMS fixture');
  git('config', 'user.email', 'fixture@invalid.test');
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(repo, 'amount.mjs'), 'export const amount = 0;\n');
  writeFileSync(
    join(repo, 'verify.mjs'),
    `import assert from 'node:assert/strict';
import {amount} from './amount.mjs';
assert.equal(amount, 10);
const response = await fetch(process.env.SOLANA_RPC_URL, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getHealth'})});
assert.equal((await response.json()).result, 'ok');
`,
  );
  mkdirSync(join(repo, '.pi', 'extensions'), { recursive: true });
  writeFileSync(
    join(repo, '.pi', 'extensions', 'untrusted.ts'),
    `import {writeFileSync} from 'node:fs'; export default function () { writeFileSync(${JSON.stringify(extensionSentinel)}, 'must never execute'); }\n`,
  );
  git('add', '.');
  git('commit', '-qm', 'initial fixture');
  const workspace = openWorkspace(repo, { stateRoot, initialize: { ignore: 'exclude' } });
  const task = createTask(workspace, { id: 'fixture', baseOid: git('rev-parse', 'HEAD') });
  const caps = { tokens: 100_000, spendMicroUsd: 1_000_000, wallClockMs: 120_000 };
  const faux = createFauxCore({
    api: 'openai-completions',
    provider: 'oms-controlled',
    models: [
      {
        id: 'controlled',
        contextWindow: 4_096,
        maxTokens: 128,
        cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
      },
    ],
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(base, 'model-auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider('oms-controlled', {
    api: faux.api,
    apiKey: 'synthetic-fixture-not-a-provider-key',
    baseUrl: 'http://127.0.0.1:1',
    streamSimple: faux.streamSimple,
    models: faux.models.map((model) => ({
      type: 'chat' as const,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  });
  const model = modelRuntime.getModel('oms-controlled', 'controlled');
  assert.ok(model);
  await prepareHarnessTask(workspace, task, environment, {
    contract: {
      version: 0,
      items: [
        {
          id: 'fixture',
          title: 'set amount and verify offline',
          status: 'active',
          reopenCount: 0,
          done: [{ kind: 'tests', command: ['node', 'verify.mjs'], expect: 'pass' }],
        },
      ],
    },
    verifierPaths: ['verify.mjs'],
    codePaths: ['amount.mjs', 'package.json'],
  });
  return {
    base,
    repo,
    workspace,
    task,
    caps,
    faux,
    modelRuntime,
    model,
    extensionSentinel,
    options: { workspace, task, environment, caps, maxOutputTokens: 128 },
  };
}
