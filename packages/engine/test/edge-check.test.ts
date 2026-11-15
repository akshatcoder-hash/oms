import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changesProgram, createEdgeCheck, EDGE_CHECK_LIMITS } from '../src/runtime/edge-check.ts';

/** Drives the extension's handlers the way pi does: tool_call before a tool, tool_result after it, turn_end after each model turn. */
function harness(paths: string[], clock = { now: 0 }) {
  const handlers = new Map<string, (event: any) => any>();
  const check = createEdgeCheck({ changedPaths: () => paths, clock: () => clock.now });
  check.extension({ on: (name: string, handler: (event: any) => any) => handlers.set(name, handler) } as any);
  const call = (toolName: string) =>
    handlers.get('tool_call')!({ type: 'tool_call', toolName, toolCallId: 'x', input: {} }) as
      { block?: boolean; reason?: string } | undefined;
  const bash = (isError: boolean) => {
    assert.equal(call('bash')?.block, undefined);
    handlers.get('tool_result')!({ type: 'tool_result', toolName: 'bash', isError, content: [] });
  };
  const turn = () => handlers.get('turn_end')!({ type: 'turn_end' });
  return { check, call, bash, turn, clock };
}

test('only Rust source changes count as a program change', () => {
  assert.equal(changesProgram(['programs/vault/src/lib.rs']), true);
  assert.equal(changesProgram(['client.ts', 'TASK.md', 'Cargo.lock']), false);
  assert.equal(changesProgram(['target/debug/build/x/out.rs', '.oms-cargo/registry/src/a.rs']), false);
});

test('a client-only change proposes done at once and never runs the pass', () => {
  const h = harness(['client.ts']);
  assert.equal(h.call('propose_done'), undefined);
  assert.deepEqual(h.check.summary(), { triggered: false, turns: 0, ms: 0, result: 'none' });
});

test('a program change gets the edge-case brief first, then at most two turns before only propose_done is allowed', () => {
  const h = harness(['programs/vault/src/lib.rs']);
  const first = h.call('propose_done');
  assert.equal(first?.block, true);
  assert.match(first!.reason!, /missing signer.*wrong .*owner.*PDA seeds.*bump.*overflow.*close.*re-init/s);
  h.turn(); // the turn that called propose_done
  h.bash(true);
  h.turn();
  h.bash(false);
  h.turn();
  assert.match(h.call('bash')?.reason ?? '', /call propose_done/);
  assert.equal(h.call('task_status'), undefined);
  assert.equal(h.call('propose_done'), undefined);
  assert.deepEqual(h.check.summary(), { triggered: true, turns: 2, ms: 0, result: 'pass' });
  assert.equal(h.call('bash'), undefined, 'the gate is open again after done was proposed');
});

test('the pass ends after three minutes even inside its first turn, and a failing last check is reported', () => {
  const h = harness(['src/lib.rs']);
  h.call('propose_done');
  h.turn();
  h.bash(true);
  h.clock.now = EDGE_CHECK_LIMITS.ms;
  assert.equal(h.call('bash')?.block, true);
  assert.equal(h.call('propose_done'), undefined);
  assert.deepEqual(h.check.summary(), { triggered: true, turns: 0, ms: EDGE_CHECK_LIMITS.ms, result: 'fail' });
});
