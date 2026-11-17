import { createServer } from 'node:http';
import { DEVNET_GENESIS_HASH } from '../src/profile.ts';

export async function controlledRpc() {
  const state = {
    genesis: DEVNET_GENESIS_HASH,
    height: 900,
    slot: 100,
    fee: 5000,
    historyAvailable: true,
    blockhash: '11111111111111111111111111111111',
    signatureStatus: null as null | { confirmationStatus: string; err: unknown },
    blockSignatures: [] as string[],
    statusSlot: null as number | null,
    historySlots: [100, 101],
    blockHeights: { 100: 1000, 101: 1001 } as Record<number, number | null>,
    blockParents: { 100: 99, 101: 100 } as Record<number, number>,
  };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { id, method, params = [] } = JSON.parse(body);
    let result: unknown;
    switch (method) {
      case 'getGenesisHash':
        result = state.genesis;
        break;
      case 'getLatestBlockhash':
        result = { context: { slot: state.slot }, value: { blockhash: state.blockhash, lastValidBlockHeight: 1000 } };
        break;
      case 'getFeeForMessage':
        result = { context: { slot: state.slot }, value: state.fee };
        break;
      case 'isBlockhashValid':
        result = { context: { slot: state.slot }, value: state.height <= 1000 };
        break;
      case 'getBlockHeight':
        result = state.height;
        break;
      case 'getSlot':
        result = state.slot;
        break;
      case 'getSignatureStatuses':
        result = { context: { slot: state.statusSlot ?? state.slot }, value: [state.signatureStatus] };
        break;
      case 'minimumLedgerSlot':
        result = state.historyAvailable ? 0 : state.slot + 1;
        break;
      case 'getBlocks':
        result = state.historySlots.filter((slot) => slot >= params[0] && slot <= params[1]);
        break;
      case 'getBlock': {
        const slot = Number(params[0]);
        const parentSlot = state.blockParents[slot];
        result = state.historyAvailable
          ? {
              signatures: state.blockSignatures,
              blockHeight: state.blockHeights[slot],
              parentSlot,
              blockhash: `block-${slot}`,
              previousBlockhash: `block-${parentSlot}`,
            }
          : null;
        break;
      }
      default:
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601 } }));
        return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
  // The workspace targets ES2023, before Promise.withResolvers.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing local RPC address');
  return {
    state,
    endpoint: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
