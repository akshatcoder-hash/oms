import { createServer } from 'node:net';

/**
 * Ports already claimed by Surfnet managers in this process, so two managers
 * created in the same tick never probe the same pair.
 */
const reserved = new Set<number>();

function isReserved(port: number): boolean {
  return reserved.has(port) || reserved.has(port + 1);
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

export interface PortPair {
  rpc: number;
  ws: number;
}

/**
 * Find a free rpc+ws port pair by bind-testing on 127.0.0.1. Pairs are even
 * (rpc) / odd (ws, rpc+1). Reserves the pair until `releasePorts` is called
 * so concurrent managers in one process do not collide; across processes the
 * bind test closes the window to the moment between close and spawn.
 */
export async function findFreePortPair(options?: {
  /** First rpc port to try; defaults to a random port in [20000, 40000). */
  from?: number;
}): Promise<PortPair> {
  const start =
    options?.from ?? 20000 + Math.floor(Math.random() * 10_000) * 2;
  const from = start % 2 === 0 ? start : start + 1;
  const limit = 40000;
  for (let rpc = from; rpc < limit; rpc += 2) {
    if (isReserved(rpc)) continue;
    const [rpcFree, wsFree] = await Promise.all([canBind(rpc), canBind(rpc + 1)]);
    if (rpcFree && wsFree) {
      reserved.add(rpc);
      return { rpc, ws: rpc + 1 };
    }
  }
  throw new Error(`no free port pair found in [${from}, ${limit})`);
}

/** Release a pair returned by `findFreePortPair` (after the child is stopped). */
export function releasePorts(pair: PortPair): void {
  reserved.delete(pair.rpc);
}
