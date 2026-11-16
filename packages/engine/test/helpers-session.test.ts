import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { hostSandbox } from '@oms/sandbox';
import { createChatFixture } from '../test-support/chat-fixture.ts';
import { barrier, call, calls, route, say, type Step } from '../test-support/helper-fixture.ts';
import { createChatSession } from '../src/runtime/chat-session.ts';
import { usageOf } from '../src/runtime/helpers/records.ts';
import type { ChatSession } from '../src/runtime/session-types.ts';

const seatbelt = { skip: hostSandbox() !== 'seatbelt' && 'needs macOS sandbox-exec' };

async function open(t: TestContext) {
  const f = await createChatFixture();
  writeFileSync(join(f.project, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(f.project, 'b.ts'), 'export const b = 2;\n');
  const sessions: ChatSession[] = [];
  const start = async (extra: Partial<typeof f.options> = {}) => {
    const chat = await createChatSession({
      ...f.options,
      caps: { tokens: 5_000_000, spendMicroUsd: 5_000_000, wallClockMs: 120_000 },
      ...extra,
    });
    sessions.push(chat);
    return chat;
  };
  t.after(async () => {
    for (const chat of sessions) await chat.close();
    rmSync(f.base, { recursive: true, force: true });
  });
  return { ...f, start };
}

const agentCall = (
  agent: string,
  task: string,
  files?: string[],
): [string, { agent: string; task: string; files?: string[] }] => [
  'agent',
  { agent, task, ...(files ? { files } : {}) },
];
const results = (chat: ChatSession) => chat.session.messages.filter((message) => message.role === 'toolResult');
const textOf = (message: unknown) => JSON.stringify((message as { content: unknown }).content);

test(
  'an explore helper reads a file and its report reaches the chat, with the chat conversation intact',
  { timeout: 60_000 },
  async (t) => {
    const f = await open(t);
    f.faux.setResponses(
      route([call(...agentCall('explore', 'EXPLORE-ONE: what does a.ts export?')), say('It exports a.')], {
        'EXPLORE-ONE': [call('read', { path: join(f.project, 'a.ts') }), say('a.ts exports the constant a.')],
      }),
    );
    const chat = await f.start();
    await chat.session.prompt('What does a.ts export?');
    const [result] = results(chat);
    assert.equal(result!.isError, false);
    assert.match(textOf(result), /a\.ts exports the constant a\./);
    assert.match(textOf(result), /\[explore \| \d+s \| /);
    assert.deepEqual(
      chat.session.messages.map((message) => message.role).filter((role) => role !== 'system'),
      ['user', 'assistant', 'toolResult', 'assistant'],
    );
    const [helper] = chat.helpers.list();
    assert.equal(helper!.status, 'done');
    assert.equal(helper!.agent, 'explore');
    assert.ok(helper!.tokens > 0);
    assert.equal(helper!.tokens, usageOf(chat.budget, helper!.turnId).tokens);
    assert.match(JSON.stringify(chat.helpers.messages(helper!.id)), /a\.ts exports the constant a\./);
  },
);

test('a helper has the read tools but never the agent tool', { timeout: 60_000 }, async (t) => {
  const f = await open(t);
  const tools: string[][] = [];
  const spy: Step = (context) => {
    tools.push([JSON.stringify(context.messages)]);
    return fauxAssistantMessage('Nothing found.');
  };
  f.faux.setResponses(
    route([call(...agentCall('explore', 'EXPLORE-TOOLS: look')), say('ok')], { 'EXPLORE-TOOLS': [spy] }),
  );
  const chat = await f.start();
  await chat.session.prompt('Look around.');
  assert.ok(chat.session.getActiveToolNames().includes('agent'));
  assert.equal(chat.helpers.list()[0]!.status, 'done');
  const declared = tools[0]![0]!;
  for (const name of ['read', 'bash', 'program_reference'])
    assert.match(declared, new RegExp(`"name":"${name}"`), name);
  for (const name of ['agent', 'edit', 'write']) assert.doesNotMatch(declared, new RegExp(`"name":"${name}"`), name);
});

test('two read helpers run at the same time', { timeout: 60_000 }, async (t) => {
  const f = await open(t);
  const both = barrier(2);
  const wait: Step = async () => {
    await both();
    return fauxAssistantMessage('Checked.');
  };
  f.faux.setResponses(
    route([calls(agentCall('explore', 'EXPLORE-A: one'), agentCall('review', 'REVIEW-B: two')), say('Both done.')], {
      'EXPLORE-A': [wait],
      'REVIEW-B': [wait],
    }),
  );
  const chat = await f.start();
  await chat.session.prompt('Use two helpers.');
  assert.deepEqual(
    chat.helpers.list().map((helper) => helper.status),
    ['done', 'done'],
  );
});

test('a long command in one helper does not hold up another helper reading a file', { timeout: 60_000 }, async (t) => {
  const f = await open(t);
  const order: string[] = [];
  const mark =
    (name: string, next: Step): Step =>
    (context) => {
      order.push(name);
      return next(context);
    };
  f.faux.setResponses(
    route([calls(agentCall('explore', 'SLOW-ONE: build'), agentCall('explore', 'FAST-TWO: read')), say('Done.')], {
      'SLOW-ONE': [call('bash', { command: 'sleep 3; echo slow' }), mark('slow-finished', say('slow'))],
      'FAST-TWO': [call('read', { path: join(f.project, 'a.ts') }), mark('fast-finished', say('fast'))],
    }),
  );
  const chat = await f.start();
  await chat.session.prompt('Go.');
  assert.deepEqual(order, ['fast-finished', 'slow-finished']);
});

test(
  'a read-only helper cannot write the folder, and the write is refused by the sandbox',
  { ...seatbelt, timeout: 60_000 },
  async (t) => {
    const f = await open(t);
    f.faux.setResponses(
      route([call(...agentCall('explore', 'PROBE-ONE: try to write')), say('Done.')], {
        'PROBE-ONE': [
          call('bash', { command: 'echo changed > a.ts; echo scratch > "$TMPDIR/probe-ok.txt" && echo temp-ok' }),
          say('Tried.'),
        ],
      }),
    );
    const chat = await f.start();
    await chat.session.prompt('Probe.');
    assert.equal(readFileSync(join(f.project, 'a.ts'), 'utf8'), 'export const a = 1;\n');
    const messages = JSON.stringify(chat.helpers.messages(chat.helpers.list()[0]!.id));
    assert.match(messages, /temp-ok/);
    assert.match(messages, /not permitted|denied|read-only/i);
  },
);

test('a build helper may change the files it claimed and nothing else', { timeout: 60_000 }, async (t) => {
  const f = await open(t);
  f.faux.setResponses(
    route([call(...agentCall('build', 'BUILD-ONE: change a', ['a.ts'])), say('Done.')], {
      'BUILD-ONE': [
        call('write', { path: join(f.project, 'a.ts'), content: 'export const a = 10;\n' }),
        call('write', { path: join(f.project, 'b.ts'), content: 'export const b = 20;\n' }),
        say('Changed a; b was refused.'),
      ],
    }),
  );
  const chat = await f.start();
  await chat.session.prompt('Change a.');
  assert.equal(readFileSync(join(f.project, 'a.ts'), 'utf8'), 'export const a = 10;\n');
  assert.equal(readFileSync(join(f.project, 'b.ts'), 'utf8'), 'export const b = 2;\n');
  assert.match(JSON.stringify(chat.helpers.messages(chat.helpers.list()[0]!.id)), /outside the files you may change/);
});

test(
  'a file a build helper changed through the shell outside its claim is named in its result',
  { ...seatbelt, timeout: 60_000 },
  async (t) => {
    const f = await open(t);
    f.faux.setResponses(
      route([call(...agentCall('build', 'BUILD-SH: sneaky', ['a.ts'])), say('Done.')], {
        'BUILD-SH': [call('bash', { command: 'echo sneaky > b.ts' }), say('Done.')],
      }),
    );
    const chat = await f.start();
    await chat.session.prompt('Go.');
    assert.match(textOf(results(chat)[0]), /touched outside claim: b\.ts/);
  },
);

test(
  'two build helpers on different files run together, and on the same file one waits for the other',
  { timeout: 60_000 },
  async (t) => {
    const f = await open(t);
    const both = barrier(2);
    const together: Step = async () => {
      await both();
      return fauxAssistantMessage('Edited.');
    };
    f.faux.setResponses(
      route(
        [calls(agentCall('build', 'BUILD-A: a', ['a.ts']), agentCall('build', 'BUILD-B: b', ['b.ts'])), say('Both.')],
        {
          'BUILD-A': [together],
          'BUILD-B': [together],
        },
      ),
    );
    const chat = await f.start();
    await chat.session.prompt('Edit both.');
    assert.deepEqual(
      chat.helpers.list().map((helper) => helper.status),
      ['done', 'done'],
    );

    const order: string[] = [];
    const note =
      (name: string): Step =>
      () => {
        order.push(name);
        return fauxAssistantMessage('ok');
      };
    const slowStart =
      (name: string): Step =>
      async () => {
        order.push(`${name}-start`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        return fauxAssistantMessage('ok');
      };
    f.faux.setResponses(
      route(
        [
          calls(agentCall('build', 'SAME-A: a', ['a.ts']), agentCall('build', 'SAME-B: a again', ['a.ts'])),
          say('Both.'),
        ],
        {
          'SAME-A': [slowStart('A')],
          'SAME-B': [note('B-start')],
        },
      ),
    );
    await chat.session.prompt('Edit the same file twice.');
    assert.deepEqual(order, ['A-start', 'B-start']);
  },
);

test('the fifth helper waits for a slot and the chat gets all five reports', { timeout: 60_000 }, async (t) => {
  const f = await open(t);
  let active = 0;
  let peak = 0;
  const hold: Step = async () => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 200));
    active--;
    return fauxAssistantMessage('ok');
  };
  const names = ['A', 'B', 'C', 'D', 'E'].map((name) => `SLOT-${name}`);
  f.faux.setResponses(
    route(
      [calls(...names.map((name) => agentCall('explore', `${name}: wait`))), say('All five.')],
      Object.fromEntries(names.map((name) => [name, [hold]])),
    ),
  );
  const chat = await f.start();
  await chat.session.prompt('Five helpers.');
  assert.equal(peak, 4);
  assert.equal(chat.helpers.list().filter((helper) => helper.status === 'done').length, 5);
});

test(
  'cancelling the chat stops its helpers and leaves no open request in the ledger',
  { timeout: 60_000 },
  async (t) => {
    const f = await open(t);
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const stuck: Step = (context) =>
      new Promise((_, reject) => {
        started();
        setTimeout(() => reject(new Error('never answered')), 20_000).unref();
        void context;
      });
    f.faux.setResponses(route([call(...agentCall('explore', 'STUCK-ONE: wait forever'))], { 'STUCK-ONE': [stuck] }));
    const chat = await f.start();
    const done = chat.session.prompt('Start a helper.');
    await running;
    await chat.session.abort();
    await done.catch(() => {});
    assert.equal(chat.helpers.list()[0]!.status, 'cancelled');
    const settled = new Set(chat.budget.receipts().map((receipt) => receipt.dispatchId));
    assert.ok(chat.budget.reservations().every((reservation) => settled.has(reservation.dispatchId)));
    f.faux.setResponses([fauxAssistantMessage('Still here.')]);
    await chat.session.prompt('Are you still there?');
    assert.match(JSON.stringify(chat.session.messages.at(-1)), /Still here\./);
  },
);

test(
  'helpers are listed again after the chat is reopened, and one that never ended shows as interrupted',
  { timeout: 60_000 },
  async (t) => {
    const f = await open(t);
    f.faux.setResponses(
      route([call(...agentCall('explore', 'KEEP-ONE: look')), say('Done.')], { 'KEEP-ONE': [say('Found nothing.')] }),
    );
    const first = await f.start();
    await first.session.prompt('Look.');
    const id = first.session.sessionManager.getSessionId();
    first.session.sessionManager.appendCustomEntry('oms.helper', {
      phase: 'start',
      record: {
        id: 'build#9',
        agent: 'build',
        task: 'half done',
        model: 'x/y',
        status: 'running',
        startedAt: Date.now(),
        turnId: 'gone',
        sessionFile: '',
      },
    });
    await first.close();
    const second = await f.start({ sessionId: id });
    const byId = Object.fromEntries(second.helpers.list().map((helper) => [helper.id, helper.status]));
    assert.deepEqual(byId, { 'explore#1': 'done', 'build#9': 'interrupted' });
  },
);

test('an unknown agent is refused with the names that exist', { timeout: 60_000 }, async (t) => {
  const f = await open(t);
  f.faux.setResponses(route([call(...agentCall('nobody', 'x')), say('Sorry.')], {}));
  const chat = await f.start();
  await chat.session.prompt('Use a helper.');
  const [result] = results(chat);
  assert.equal(result!.isError, true);
  assert.match(textOf(result), /No agent named \\"nobody\\"\. Available: .*explore.*build.*review/);
});

test(
  'a custom agent file in the project is used, and the agent can read the folder only',
  { timeout: 60_000 },
  async (t) => {
    const f = await open(t);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(f.project, '.oms-agents'));
    writeFileSync(
      join(f.project, '.oms-agents', 'auditor.md'),
      '---\nname: auditor\ndescription: Check exports\ntools: read\n---\nYou audit exports.\n',
    );
    f.faux.setResponses(
      route([call(...agentCall('auditor', 'AUDIT-ONE: check')), say('Done.')], {
        'AUDIT-ONE': [say('All exports checked.')],
      }),
    );
    const chat = await f.start();
    assert.ok(chat.helpers.agents().agents.some((agent) => agent.name === 'auditor' && agent.source === 'project'));
    await chat.session.prompt('Audit.');
    assert.match(textOf(results(chat)[0]), /All exports checked\./);
    assert.ok(existsSync(join(f.project, '.oms-agents', 'auditor.md')));
  },
);

test('at most twelve helpers start for one request', { timeout: 60_000 }, async (t) => {
  const f = await open(t);
  const names = Array.from({ length: 13 }, (_, index) => `MANY-${String(index).padStart(2, '0')}`);
  f.faux.setResponses(
    route(
      [calls(...names.map((name) => agentCall('explore', `${name}: quick`))), say('Done.')],
      Object.fromEntries(names.map((name) => [name, [say('ok')]])),
    ),
  );
  const chat = await f.start();
  await chat.session.prompt('Many helpers.');
  const refused = results(chat).filter((result) => result.isError);
  assert.equal(refused.length, 1);
  assert.match(textOf(refused[0]), /At most 12 helpers/);
  assert.equal(chat.helpers.list().length, 12);
});

test(
  'YOLO applies to helpers as to the chat, and a read-only helper then says its limit is not enforced',
  { timeout: 60_000 },
  async (t) => {
    const f = await open(t);
    f.faux.setResponses(
      route([call(...agentCall('explore', 'YOLO-ONE: write anyway')), say('Done.')], {
        'YOLO-ONE': [call('bash', { command: 'echo changed > a.ts' }), say('Wrote it.')],
      }),
    );
    const chat = await f.start({ yolo: true } as never);
    await chat.session.prompt('Go.');
    const text = textOf(results(chat)[0]);
    assert.match(text, /read-only is not enforced for commands here/);
    assert.match(text, /changed files \(read-only agent\): a\.ts/);
  },
);
