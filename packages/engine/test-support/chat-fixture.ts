import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveChatFolder } from '../src/runtime/chat-folder.ts';
import { defaultHarnessEnvironment } from '../src/runtime/environment.ts';
import type { ChatSessionOptions } from '../src/runtime/session-types.ts';
import { createFauxModel } from './runtime-fixture.ts';

/** A real folder, a private state root and a scripted model; the folder is committed when `git` is set. */
export async function createChatFixture({ git = false } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oms-chat-')));
  const project = join(base, 'project');
  const stateRoot = join(base, 'state');
  mkdirSync(project, { mode: 0o700 });
  writeFileSync(join(project, 'notes.txt'), 'draft\n');
  writeFileSync(join(project, '.env'), 'API_TOKEN=TOP_SECRET_VALUE\n');
  writeFileSync(join(project, '.env.example'), 'API_TOKEN=\n');
  if (git) {
    const run = (...args: string[]) =>
      execFileSync('git', ['-C', project, ...args], {
        env: { PATH: process.env.PATH, HOME: base, GIT_CONFIG_NOSYSTEM: '1' },
        stdio: 'ignore',
      });
    run('init', '-q');
    run('config', 'user.name', 'OMS fixture');
    run('config', 'user.email', 'fixture@invalid.test');
    run('add', '.');
    run('commit', '-qm', 'initial');
  }
  const { faux, modelRuntime, model } = await createFauxModel(base);
  const folder = resolveChatFolder(project, { stateRoot });
  const options: ChatSessionOptions = {
    folder,
    stateRoot,
    environment: defaultHarnessEnvironment(
      process.env.SURFPOOL_BINARY ?? join(homedir(), '.local/bin/surfpool'),
      'host',
    ),
    caps: { tokens: 100_000, spendMicroUsd: 1_000_000, wallClockMs: 120_000 },
    maxOutputTokens: 128,
    executionMode: 'interactive',
    hostApprovalPolicy: 'allow',
    modelRuntime,
    model,
  };
  return { base, project, stateRoot, folder, faux, options };
}
