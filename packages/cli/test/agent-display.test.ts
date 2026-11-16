import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setKeybindings } from '@earendil-works/pi-tui';
import { displayDefinition } from '../src/tui/display-tools.ts';
import { omsKeybindings } from '../src/tui/interface.ts';
import { Conversation } from '../src/tui/transcript.ts';

setKeybindings(omsKeybindings({}));

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const plain = (lines: string[]) =>
  lines
    .join('\n')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b\]133;[A-C]\x07/g, '');

const helperMessages = [
  { role: 'user', content: [{ type: 'text', text: 'Find exports' }], timestamp: 1 },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Look at a.ts first.' },
      { type: 'toolCall', id: 'h1', name: 'bash', arguments: { command: 'echo API_TOKEN=abcdef123456' } },
    ],
    stopReason: 'toolUse',
    usage,
    api: 'x',
    provider: 'p',
    model: 'm',
    timestamp: 2,
  },
  {
    role: 'toolResult',
    toolCallId: 'h1',
    toolName: 'bash',
    content: [{ type: 'text', text: 'API_TOKEN=abcdef123456\n' }],
    isError: false,
    timestamp: 3,
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'a.ts exports a.' }],
    stopReason: 'stop',
    usage,
    api: 'x',
    provider: 'p',
    model: 'm',
    timestamp: 4,
  },
];

function chat(): Conversation {
  const options = {
    cwd: '/work/project',
    toolDefinition: (name: string) =>
      displayDefinition(
        name,
        { name },
        {
          transcript: (id) =>
            id === 'explore#1' ? new Conversation(helperMessages, undefined, { cwd: '/work/project' }) : undefined,
        },
      ),
  };
  return new Conversation([], undefined, options);
}

function call(conversation: Conversation, id: string, agent: string, task: string) {
  const assistant = {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'agent', arguments: { agent, task } }],
    stopReason: 'toolUse',
    usage,
    api: 'x',
    provider: 'p',
    model: 'm',
    timestamp: 2,
  };
  conversation.accept({ type: 'message_start', message: assistant } as never);
  conversation.accept({ type: 'message_end', message: assistant } as never);
  conversation.accept({
    type: 'tool_execution_start',
    toolCallId: id,
    toolName: 'agent',
    args: { agent, task },
  } as never);
}

test('a helper is one line: agent, task, then how it is going and its one-line result', () => {
  const conversation = chat();
  call(conversation, 'a1', 'explore', 'find what each module exports');
  conversation.accept({
    type: 'tool_execution_update',
    toolCallId: 'a1',
    toolName: 'agent',
    args: { agent: 'explore', task: 'find what each module exports' },
    partialResult: {
      content: [{ type: 'text', text: 'explore running 4s' }],
      details: { id: 'explore#1', agent: 'explore', status: 'running', elapsedMs: 4000, tokens: 0 },
    },
  } as never);
  assert.match(plain(conversation.render(120)), /explore "find what each module exports" · running 4s/);
  conversation.accept({
    type: 'tool_execution_end',
    toolCallId: 'a1',
    toolName: 'agent',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'a.ts exports a. b.ts exports b.\n[explore | 14s | 22k tokens]' }],
      details: {
        id: 'explore#1',
        agent: 'explore',
        status: 'done',
        elapsedMs: 14_000,
        tokens: 22_400,
        summary: 'a.ts exports a. b.ts exports b.',
      },
    },
  } as never);
  const screen = plain(conversation.render(160));
  const line = screen.split('\n').filter((row) => row.includes('explore'));
  assert.equal(line.length, 1, 'one line for the helper');
  assert.match(
    line[0]!,
    /explore "find what each module exports" · done 14s · 22k tokens · a\.ts exports a\. b\.ts exports b\./,
  );
  assert.doesNotMatch(screen, /\[explore \| 14s/);
});

test('a helper that failed shows why, in the same line', () => {
  const conversation = chat();
  call(conversation, 'a2', 'build', 'change a.ts');
  conversation.accept({
    type: 'tool_execution_end',
    toolCallId: 'a2',
    toolName: 'agent',
    isError: true,
    result: { content: [{ type: 'text', text: 'build failed after 3s: stopped after 40 turns' }] },
  } as never);
  assert.match(
    plain(conversation.render(160)),
    /build "change a\.ts" · failed · build failed after 3s: stopped after 40 turns/,
  );
});

test("Ctrl+O opens the helper's own conversation: thinking, one-line tools, secrets masked", () => {
  const conversation = chat();
  call(conversation, 'a1', 'explore', 'find exports');
  conversation.accept({
    type: 'tool_execution_end',
    toolCallId: 'a1',
    toolName: 'agent',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'done' }],
      details: { id: 'explore#1', agent: 'explore', status: 'done', elapsedMs: 1000, tokens: 10 },
    },
  } as never);
  assert.doesNotMatch(plain(conversation.render(120)), /Look at a\.ts first\./);
  conversation.toggleToolOutput();
  const expanded = plain(conversation.render(120));
  assert.match(expanded, /Look at a\.ts first\./);
  assert.match(expanded, /a\.ts exports a\./);
  assert.match(expanded, /API_TOKEN=••••/);
  assert.doesNotMatch(expanded, /abcdef123456/);
});

test('a long task is cut with an ellipsis, not with a display warning', () => {
  const conversation = chat();
  const task =
    'In the project at /private/tmp/some/long/path read src/vault.ts and add a header comment naming its exports';
  call(conversation, 'a3', 'build', task);
  conversation.accept({
    type: 'tool_execution_end',
    toolCallId: 'a3',
    toolName: 'agent',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'done' }],
      details: { id: 'build#3', agent: 'build', status: 'done', elapsedMs: 9000, tokens: 40_000 },
    },
  } as never);
  const screen = plain(conversation.render(200));
  assert.match(screen, /build "In the project at \/private\/tmp\/some\/long\/pa…" · done 9s · 40k tokens/);
  assert.doesNotMatch(screen, /display truncated/);
});

test('a helper stopped with the chat reads as cancelled, not failed', () => {
  const conversation = chat();
  call(conversation, 'a4', 'explore', 'look around');
  conversation.accept({
    type: 'tool_execution_end',
    toolCallId: 'a4',
    toolName: 'agent',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'explore was cancelled.' }],
      details: { id: 'explore#4', agent: 'explore', status: 'cancelled', elapsedMs: 55_000, tokens: 0 },
    },
  } as never);
  const screen = plain(conversation.render(160));
  assert.match(screen, /explore "look around" · cancelled 55s · 0 tokens/);
  assert.doesNotMatch(screen, /failed/);
});
