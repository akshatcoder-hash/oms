import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFirstTurn, HEADLESS_INSTRUCTION } from '../src/headless.ts';

const status = { items: [{ id: 'swap', title: 'Swap tokens', status: 'active' }] };

test('the first turn carries the task status, TASK.md and primer, so no orientation call is needed', () => {
  const turn = buildFirstTurn({ status, brief: '# Build the swap\nUse kit.', primer: 'PRIMER-MARK' });
  assert.ok(turn.startsWith(HEADLESS_INSTRUCTION));
  assert.ok(turn.includes(JSON.stringify(status, null, 2)));
  assert.ok(turn.includes('# Build the swap\nUse kit.'));
  assert.ok(turn.endsWith('PRIMER-MARK'));
});

test('absent status, brief and primer leave only the instruction', () => {
  assert.equal(buildFirstTurn({ brief: '' }), HEADLESS_INSTRUCTION);
});
