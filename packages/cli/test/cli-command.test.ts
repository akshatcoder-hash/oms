import assert from 'node:assert/strict';
import { test } from 'node:test';
import { omsCommand } from '@oms/engine';

test('the next command uses npx only for npm exec and npx launches', () => {
  assert.equal(omsCommand({ npm_command: 'exec' }), 'npx @barestate/oms');
  assert.equal(omsCommand({}), 'oms');
  assert.equal(omsCommand({ npm_command: 'start' }), 'oms');
  assert.equal(omsCommand({ npm_command: 'run-script' }), 'oms');
  assert.equal(omsCommand({ npm_command: 'unknown' }), 'oms');
});
