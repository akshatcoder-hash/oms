import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { displayDefinition } from '../src/tui/display-tools.ts';
import { setKeybindings } from '@earendil-works/pi-tui';
import { omsKeybindings } from '../src/tui/interface.ts';
import { Conversation } from '../src/tui/transcript.ts';

const cwd = '/work/project';
const definitions: Record<string, unknown> = {
  read: createReadToolDefinition(cwd),
  write: createWriteToolDefinition(cwd),
  edit: createEditToolDefinition(cwd),
  bash: createBashToolDefinition(cwd),
};
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

const BIG = Array.from({ length: 80 }, (_, i) => `line ${i + 1} of the file`).join('\n');
const calls = [
  { id: 'r1', name: 'read', arguments: { path: 'src/big.ts', offset: 1, limit: 80 } },
  { id: 'w1', name: 'write', arguments: { path: 'hello.mjs', content: 'console.log("hello");\nconsole.log(1);\n' } },
  { id: 'w2', name: 'write', arguments: { path: 'old.txt', content: 'new line\n' } },
  { id: 'e1', name: 'edit', arguments: { path: 'hello.mjs', edits: [{ oldText: 'hello', newText: 'hi' }] } },
  { id: 'b1', name: 'bash', arguments: { command: 'node hello.mjs' } },
  { id: 'f1', name: 'web_fetch', arguments: { url: 'https://solana.com/docs' } },
  { id: 's1', name: 'solana_docs_search', arguments: { query: 'priority fees' } },
];
const results: Record<string, { text: string; details?: unknown }> = {
  r1: { text: BIG },
  w1: { text: 'Successfully wrote', details: { created: true, lines: 2 } },
  w2: { text: 'Successfully wrote', details: { created: false, lines: 1, diff: '-1 old line\n+1 new line' } },
  e1: { text: 'Edited', details: { diff: '-1 console.log("hello");\n+1 console.log("hi");', firstChangedLine: 1 } },
  b1: { text: Array.from({ length: 12 }, (_, i) => `out ${i + 1}`).join('\n') + '\n' },
  f1: { text: '{"raw":"json","blob":true}' },
  s1: { text: '{"results":[{"title":"raw json"}]}' },
};
const assistant = {
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'Plan: write, run, edit.' },
    { type: 'text', text: 'Working on it.' },
    ...calls.map((call) => ({ type: 'toolCall', ...call })),
  ],
  stopReason: 'toolUse',
  usage,
  api: 'x',
  provider: 'p',
  model: 'm',
  timestamp: 2,
};
const options = {
  cwd,
  toolDefinition: (name: string) => displayDefinition(name, definitions[name] ?? { name }),
};

function streamed(): Conversation {
  const conversation = new Conversation([], undefined, options);
  const accept = (event: unknown) => conversation.accept(event as never);
  accept({ type: 'message_start', message: { role: 'user', content: 'Do the task', timestamp: 1 } });
  accept({ type: 'message_start', message: assistant });
  accept({ type: 'message_end', message: assistant });
  for (const call of calls) {
    accept({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments });
    const result = results[call.id]!;
    accept({
      type: 'tool_execution_end',
      toolCallId: call.id,
      toolName: call.name,
      isError: false,
      result: { content: [{ type: 'text', text: result.text }], details: result.details },
    });
  }
  return conversation;
}

test('tool calls show what happened, not what was read or written', () => {
  const screen = plain(streamed().render(100));
  assert.match(screen, /Plan: write, run, edit\./, 'thinking is shown');
  assert.match(screen, /read .*src\/big\.ts/);
  assert.ok(!screen.includes('line 40 of the file'), 'a read never dumps the file');
  assert.match(screen, /Wrote hello\.mjs \(2 lines\)/);
  assert.ok(!screen.includes('console.log(1)'), 'a new file shows no content');
  assert.match(screen, /write old\.txt/);
  assert.match(screen, /-1 old line/);
  assert.match(screen, /\+1 new line/);
  assert.match(screen, /-1 console\.log\("hello"\);/);
  assert.match(screen, /\+1 console\.log\("hi"\);/);
  assert.match(screen, /\$ node hello\.mjs/);
  assert.match(screen, /out 12/);
  assert.doesNotMatch(screen, /out 1 *\n/, 'a command shows its last lines only');
  assert.match(screen, /Fetched https:\/\/solana\.com\/docs/);
  assert.match(screen, /Searched Solana docs: "priority fees"/);
  assert.ok(!screen.includes('"raw"') && !screen.includes('"results"'), 'no raw JSON');
});

test('Ctrl+O shows the whole output and Ctrl+T hides thinking', () => {
  const conversation = streamed();
  assert.equal(conversation.toggleToolOutput(), true);
  const expanded = plain(conversation.render(100));
  assert.match(expanded, /line 40 of the file/);
  assert.match(expanded, /console\.log\(1\)/);
  assert.match(expanded, /out 1 *\n/);
  assert.equal(conversation.toggleThinking(), true);
  assert.ok(!plain(conversation.render(100)).includes('Plan: write, run, edit.'));
});

test('a restored conversation reads the same as the live one', () => {
  const live = plain(streamed().render(100));
  const history = [
    { role: 'user', content: 'Do the task', timestamp: 1 },
    assistant,
    ...calls.map((call) => ({
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: 'text', text: results[call.id]!.text }],
      details: results[call.id]!.details,
      isError: false,
      timestamp: 3,
    })),
  ];
  const restored = plain(new Conversation(history, undefined, options).render(100));
  const strip = (text: string) => text.replace(/Took [\d.]+s/g, '').replace(/\s+/g, ' ');
  assert.equal(strip(restored), strip(live));
});

test('an absolute path inside the folder is shown relative to it, and the edit diff still appears', () => {
  const absolute = [
    { ...calls[3]!, arguments: { path: `${cwd}/src/hello.mjs`, edits: [{ oldText: 'hello', newText: 'hi' }] } },
    { ...calls[0]!, arguments: { path: `${cwd}/src/big.ts` } },
  ];
  const message = { ...assistant, content: absolute.map((call) => ({ type: 'toolCall', ...call })) };
  const conversation = new Conversation([], undefined, options);
  conversation.accept({ type: 'message_start', message } as never);
  conversation.accept({ type: 'message_end', message } as never);
  for (const call of absolute) {
    conversation.accept({
      type: 'tool_execution_start',
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
    } as never);
    const result = results[call.id]!;
    conversation.accept({
      type: 'tool_execution_end',
      toolCallId: call.id,
      toolName: call.name,
      isError: false,
      result: { content: [{ type: 'text', text: result.text }], details: result.details },
    } as never);
  }
  const screen = plain(conversation.render(100));
  assert.match(screen, /edit src\/hello\.mjs/);
  assert.match(screen, /read src\/big\.ts/);
  assert.ok(!screen.includes(cwd), 'the folder prefix is dropped');
  assert.match(screen, /\+1 console\.log\("hi"\);/);
});

test('collapsed output names the key that expands it', () => {
  setKeybindings(omsKeybindings({}));
  assert.match(plain(streamed().render(100)), /ctrl\+o to expand/);
});
