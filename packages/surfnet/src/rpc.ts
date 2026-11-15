import { normalizeError, normalizeTransportError, type NormalizedError } from './normalize.ts';

/** Typed RPC failure carrying the normalized {code, summary, hint} shape. */
export class SurfnetRpcError extends Error {
  readonly normalized: NormalizedError;

  constructor(normalized: NormalizedError) {
    super(normalized.summary);
    this.name = 'SurfnetRpcError';
    this.normalized = normalized;
  }
}

export interface RpcCallOptions {
  /** Per-call timeout in ms. Default 30_000. */
  timeoutMs?: number;
}

export interface RpcClient {
  readonly url: string;
  /**
   * Call a JSON-RPC method. Resolves with the `result` value or throws
   * `SurfnetRpcError` (already normalized; see `error.normalized`).
   */
  call(method: string, params?: unknown[], options?: RpcCallOptions): Promise<unknown>;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  id?: unknown;
}

/**
 * Minimal fetch-based JSON-RPC client for one surfnet endpoint. No retries:
 * callers decide policy (the queue and the manager own retries).
 */
export function createRpcClient(url: string): RpcClient {
  let nextId = 1;
  return {
    url,
    async call(method, params = [], options = {}) {
      const timeoutMs = options.timeoutMs ?? 30_000;
      const id = nextId++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          signal: controller.signal,
        });
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        const aborted = cause.includes('abort') || (error as { name?: string })?.name === 'AbortError';
        throw new SurfnetRpcError(
          normalizeTransportError(
            aborted ? `RPC ${method} timed out after ${timeoutMs}ms` : `RPC ${method} failed: ${cause}`,
            'unreachable',
            'check that the surfnet process is alive (health()) and that the RPC url is correct',
          ),
        );
      } finally {
        clearTimeout(timer);
      }
      let body: JsonRpcResponse;
      try {
        body = (await response.json()) as JsonRpcResponse;
      } catch {
        throw new SurfnetRpcError(
          normalizeTransportError(
            `RPC ${method}: non-JSON response (HTTP ${response.status})`,
            'unreachable',
            'the endpoint answered but not with JSON-RPC; the url may point at the wrong port',
          ),
        );
      }
      if (body.error) {
        throw new SurfnetRpcError(
          normalizeError({
            message: body.error.message ?? 'unknown RPC error',
            code: body.error.code,
            data: body.error.data,
          }),
        );
      }
      return body.result;
    },
  };
}

/** True when the error is a `SurfnetRpcError` (duck check, safe across realms). */
export function isSurfnetRpcError(error: unknown): error is SurfnetRpcError {
  return error instanceof Error && error.name === 'SurfnetRpcError' && 'normalized' in error;
}
