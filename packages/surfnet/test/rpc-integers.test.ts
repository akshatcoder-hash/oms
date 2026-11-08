import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createRpcClient } from '../src/rpc.ts';

test('snapshot RPC preserves u64::MAX exactly without changing ordinary numeric RPC calls', async t => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"jsonrpc":"2.0","id":1,"result":{"value":{"rentEpoch":18446744073709551615,"lamports":42}}}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const port = (server.address() as { port: number }).port;
  const rpc = createRpcClient(`http://127.0.0.1:${port}`);
  const exact = await rpc.call('surfnet_exportSnapshot', [], { preserveIntegers: true });
  assert.equal(JSON.stringify(exact), '{"value":{"rentEpoch":18446744073709551615,"lamports":42}}');
  const ordinary = await rpc.call('getAccountInfo') as {value:{rentEpoch:unknown;lamports:number}};
  assert.equal(typeof ordinary.value.rentEpoch, 'number');
  assert.equal(ordinary.value.lamports, 42);
});
