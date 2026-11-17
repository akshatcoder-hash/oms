import type { HealthReport, Surfnet, SurfnetMode } from '@oms/surfnet';

/** Read methods plus the airdrop faucet: all a user-facing chain command needs, all local-only. Cheat codes are not reachable. */
export const CHAIN_METHODS: ReadonlySet<string> = new Set([
  'getHealth',
  'getSlot',
  'getVersion',
  'getEpochInfo',
  'getBalance',
  'getAccountInfo',
  'getTransaction',
  'requestAirdrop',
]);

/** The task's own local Surfpool, as the TUI's chain commands may use it. Nothing here can reach another network. */
export interface ChainControls {
  /** The task's loopback RPC URL, or undefined while the chain is down. */
  rpcUrl(): string | undefined;
  /** Always offline in a task session. */
  readonly mode: SurfnetMode;
  /** Milliseconds since the chain last started or was rewound. */
  uptimeMs(): number;
  health(): Promise<HealthReport>;
  /** One allowlisted JSON-RPC method on the local chain. */
  call(method: string, params?: unknown[]): Promise<unknown>;
  /** Restart the chain from its startup state. Waits for any running task action, so it never races a command. */
  rewind(): Promise<void>;
}

export function createChainControls(options: {
  surfnet: Surfnet;
  clock?: () => number;
  withUserOperation<T>(action: () => Promise<T>): Promise<T>;
}): ChainControls {
  const { surfnet } = options;
  const clock = options.clock ?? Date.now;
  let startedAt = clock();
  return {
    rpcUrl: () => surfnet.rpcUrl(),
    mode: surfnet.mode,
    uptimeMs: () => clock() - startedAt,
    health: () => surfnet.health(),
    call(method, params = []) {
      if (!CHAIN_METHODS.has(method))
        return Promise.reject(new Error(`Chain method ${method} is not available from commands`));
      return surfnet.rpc.call(method, params, { timeoutMs: 15_000 });
    },
    rewind: () =>
      options.withUserOperation(async () => {
        await surfnet.rewindToStart();
        startedAt = clock();
      }),
  };
}
