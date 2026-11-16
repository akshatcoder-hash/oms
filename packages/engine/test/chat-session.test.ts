import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { hostSandbox } from '@oms/sandbox';
import { createChatFixture } from '../test-support/chat-fixture.ts';
import { ChatBusyError, createChatSession, latestChatSession } from '../src/runtime/chat-session.ts';
import { chatRoot } from '../src/runtime/session-root.ts';
import type { ChatSession } from '../src/runtime/session-types.ts';

const seatbelt = { skip: hostSandbox() !== 'seatbelt' && 'needs macOS sandbox-exec' };
const tree = (directory: string) => readdirSync(directory, { recursive: true }).map(String).sort();

async function open(t: TestContext, git = false) {
  const f = await createChatFixture({ git });
  const sessions: ChatSession[] = [];
  const start = async (extra: Partial<typeof f.options> = {}) => {
    const chat = await createChatSession({ ...f.options, ...extra });
    sessions.push(chat);
    return chat;
  };
  t.after(async () => {
    for (const chat of sessions) await chat.close();
    rmSync(f.base, { recursive: true, force: true });
  });
  return { ...f, start };
}

test(
  'an edit lands in the folder in place, OMS writes nothing there, and its state stays under the state root',
  { timeout: 60_000 },
  async (t) => {
    const f = await open(t, true);
    writeFileSync(join(f.project, 'notes.txt'), 'draft, not committed\n');
    const before = tree(f.project);
    f.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall('edit', {
          path: join(f.project, 'notes.txt'),
          edits: [{ oldText: 'draft, not committed', newText: 'final' }],
        }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Edited the notes.'),
    ]);
    const chat = await f.start();
    await chat.session.prompt('Finish the notes.');
    assert.equal(readFileSync(join(f.project, 'notes.txt'), 'utf8'), 'final\n');
    assert.deepEqual(tree(f.project), before);
    await chat.close();
    assert.deepEqual(tree(f.project), before);
    assert.equal(chat.root, f.project);
    const stored = readdirSync(join(f.stateRoot, 'folders', f.folder.key));
    assert.ok(stored.includes('sessions') && stored.includes('folder.json'));
    assert.equal(existsSync(join(f.project, '.oms')), false);
  },
);

test(
  'a chat has no proposal or task status tool, and does have the file and shell tools',
  { timeout: 60_000 },
  async (t) => {
    const f = await open(t);
    const tools = (await f.start()).session.getActiveToolNames();
    for (const name of ['read', 'edit', 'write', 'bash', 'toolchain_check']) assert.ok(tools.includes(name), name);
    assert.ok(!tools.includes('propose_done') && !tools.includes('task_status'));
  },
);

test('the chat prompt names the folder and drops the pinned task rules', { timeout: 60_000 }, async (t) => {
  const f = await open(t);
  const prompt = (await f.start()).session.systemPrompt;
  assert.match(prompt, new RegExp(`You work in place in ${f.project}`));
  assert.doesNotMatch(prompt, /Call propose_done|task_status returns|Work only in the selected/);
});

test(
  '.env files are refused to the file tools while the example template is readable',
  { timeout: 60_000 },
  async (t) => {
    const f = await open(t);
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('read', { path: join(f.project, '.env') }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('read', { path: join(f.project, '.env.example') }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
    ]);
    const chat = await f.start();
    await chat.session.prompt('Show me the environment files.');
    const results = chat.session.messages.filter((message) => message.role === 'toolResult');
    assert.equal(results.length, 2);
    assert.equal(results[0]!.isError, true);
    assert.equal(results[1]!.isError, false);
    assert.ok(!JSON.stringify(chat.session.messages).includes('TOP_SECRET_VALUE'));
  },
);

test('a shell command cannot read .env under the sandbox', { ...seatbelt, timeout: 60_000 }, async (t) => {
  const f = await open(t);
  const chat = await f.start();
  const blocked = await chat.runCommand('cat .env');
  assert.notEqual(blocked.exitCode, 0);
  assert.ok(!(blocked.stdout + blocked.stderr).includes('TOP_SECRET_VALUE'));
  assert.equal((await chat.runCommand('cat .env.example')).exitCode, 0);
});

test(
  'git add and commit work in a repository, but its hooks and config stay read-only',
  { ...seatbelt, timeout: 60_000 },
  async (t) => {
    const f = await open(t, true);
    const chat = await f.start();
    assert.equal(
      (await chat.runCommand('echo more >> notes.txt && git add notes.txt && git commit -qm more')).exitCode,
      0,
    );
    const hook = await chat.runCommand('printf "#!/bin/sh\\n" > .git/hooks/pre-commit');
    assert.match(hook.stderr, /not permitted|denied/i);
    assert.notEqual((await chat.runCommand('git config user.name someone-else')).exitCode, 0);
    assert.equal(existsSync(join(f.project, '.git', 'hooks', 'pre-commit')), false);
  },
);

test('relaunching resumes the most recent conversation', { timeout: 60_000 }, async (t) => {
  const f = await open(t);
  assert.equal(latestChatSession(f.folder, f.stateRoot), undefined);
  f.faux.setResponses([fauxAssistantMessage('Noted.')]);
  const first = await f.start();
  await first.session.prompt('Remember the number 42.');
  const id = first.session.sessionManager.getSessionId();
  await first.close();
  const saved = latestChatSession(f.folder, f.stateRoot);
  assert.equal(saved?.sessionId, id);
  const second = await f.start({ sessionId: saved!.sessionId });
  assert.equal(second.session.sessionManager.getSessionId(), id);
  assert.match(JSON.stringify(second.session.messages), /Remember the number 42/);
});

test(
  'a second window in the same folder is refused, and the folder opens again once the first closes',
  { timeout: 60_000 },
  async (t) => {
    const f = await open(t);
    const first = await f.start();
    await assert.rejects(
      f.start(),
      (error) => error instanceof ChatBusyError && /already open in this folder/.test(error.message),
    );
    await first.close();
    await f.start();
  },
);

test('a window that died without closing is taken over', { timeout: 60_000 }, async (t) => {
  const f = await open(t);
  const root = chatRoot(f.folder, f.stateRoot);
  const lease = fileURLToPath(new URL('../src/workspace/lease.ts', import.meta.url));
  const crashed = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { acquireMutationLease } from ${JSON.stringify(lease)}; acquireMutationLease(${JSON.stringify(root.leaseFile)});`,
  ]);
  assert.equal(crashed.status, 0, crashed.stderr.toString());
  assert.equal(existsSync(root.leaseFile), true);
  await f.start();
});

test('Docker is refused for a chat and names the pinned-task path', async (t) => {
  const f = await open(t);
  await assert.rejects(
    f.start({ environment: { ...f.options.environment, backend: 'docker' } }),
    /Docker chats need a pinned task: use oms task create and oms run\./,
  );
});

test('a launch that sends nothing leaves no budget journal or trace behind', { timeout: 60_000 }, async (t) => {
  const f = await open(t);
  const chat = await f.start();
  await chat.close();
  const sessions = join(f.stateRoot, 'folders', f.folder.key, 'sessions');
  assert.deepEqual(existsSync(sessions) ? readdirSync(sessions) : [], []);
});

test('a conversation that did run keeps its journal and trace', { timeout: 60_000 }, async (t) => {
  const f = await open(t);
  f.faux.setResponses([fauxAssistantMessage('Hello.')]);
  const chat = await f.start();
  await chat.session.prompt('hi');
  await chat.close();
  const sessions = join(f.stateRoot, 'folders', f.folder.key, 'sessions');
  const names = readdirSync(sessions);
  for (const suffix of ['.budget.jsonl', '.trace.jsonl', '.jsonl'])
    assert.ok(
      names.some((name) => name.endsWith(suffix)),
      suffix,
    );
});

test('git init works in a folder that is not a repository yet', { ...seatbelt, timeout: 60_000 }, async (t) => {
  const f = await open(t);
  const chat = await f.start();
  const init = await chat.runCommand('git init -q && git add notes.txt && git commit -qm first');
  assert.equal(init.exitCode, 0, init.stderr);
  assert.equal(existsSync(join(f.project, '.git', 'hooks')), true);
});

test('on macOS a command runs inside the sandbox without asking', { ...seatbelt, timeout: 60_000 }, async (t) => {
  const f = await open(t);
  const chat = await f.start();
  let asked = 0;
  chat.setHostApproval?.(async () => (++asked, false));
  const result = await chat.runCommand('echo hi > made.txt && cat made.txt');
  assert.equal(result.stdout.trim(), 'hi');
  assert.equal(asked, 0);
  const outside = join(homedir(), `.oms-outside-${process.pid}-${Date.now()}.txt`);
  t.after(() => rmSync(outside, { force: true }));
  assert.notEqual((await chat.runCommand(`echo x > ${outside}`)).exitCode, 0);
  assert.equal(existsSync(outside), false);
});

test(
  'YOLO lets a command write outside the folder, and turning it off restores the sandbox',
  {
    ...seatbelt,
    timeout: 60_000,
  },
  async (t) => {
    const f = await open(t);
    const chat = await f.start();
    const outside = join(homedir(), `.oms-outside-${process.pid}-${Date.now()}.txt`);
    t.after(() => rmSync(outside, { force: true }));
    chat.yolo.set(true);
    assert.equal((await chat.runCommand(`echo x > ${outside}`)).exitCode, 0);
    assert.equal(existsSync(outside), true);
    rmSync(outside);
    chat.yolo.set(false);
    assert.notEqual((await chat.runCommand(`echo x > ${outside}`)).exitCode, 0);
  },
);

test('a chat started with yolo reports it on', { timeout: 60_000 }, async (t) => {
  const f = await open(t);
  const chat = await f.start({ yolo: true });
  assert.equal(chat.yolo.enabled(), true);
});

test(
  'without a sandbox a command waits for approval, and the session answer is remembered',
  {
    skip: hostSandbox() === 'seatbelt' && 'the sandbox answers instead',
    timeout: 60_000,
  },
  async (t) => {
    const f = await open(t);
    const chat = await f.start();
    let asked = 0;
    chat.setHostApproval?.(async () => (++asked, 'session'));
    await chat.runCommand('echo a');
    await chat.runCommand('echo a');
    assert.equal(asked, 1);
  },
);

test(
  'a command the sandbox probably refused ends with one line naming /yolo',
  { ...seatbelt, timeout: 60_000 },
  async (t) => {
    const f = await open(t);
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('bash', { command: 'echo "getaddrinfo ENOTFOUND registry" >&2; exit 1' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage(fauxToolCall('bash', { command: 'echo plain failure >&2; exit 1' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Done.'),
    ]);
    const chat = await f.start();
    await chat.session.prompt('try the network');
    const results = JSON.stringify(chat.session.messages.filter((m) => m.role === 'toolResult'));
    assert.equal(results.split('Blocked by the sandbox (network). /yolo allows it.').length - 1, 1);
  },
);
