import assert from 'node:assert/strict';
import { test } from 'node:test';

test('at least one pair counts', async () => {
  const response = await fetch(process.env.SOLANA_RPC_URL!, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'solbench_status' }) });
  const { score } = (await response.json()).result;
  console.log(`score ${score.headline} (raw ${score.raw}, arbitrary ${score.arbitrary}), submissions ${score.submissions}`);
  assert.ok(score.headline >= 1, 'no pair counts yet');
});
