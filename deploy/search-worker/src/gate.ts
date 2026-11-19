import { Semaphore } from './semaphore.ts';

export const CONTEXT_DEV_CONCURRENCY = 5;
export const QUEUE_WAIT_MS = 4_000;
const LEASE_MS = 90_000;

export interface UsageEvent {
  route: 'search' | 'fetch';
  /** First 16 hex characters of the caller's token digest. */
  token: string;
  credits: number;
}

interface Tally {
  requests: number;
  credits: number;
}
export interface DayUsage extends Tally {
  date: string;
  routes: Record<string, Tally>;
  tokens: Record<string, Tally>;
}

const add = (into: Record<string, Tally>, key: string, credits: number) => {
  const tally = (into[key] ??= { requests: 0, credits: 0 });
  tally.requests += 1;
  tally.credits += credits;
};

/**
 * One instance (idFromName('context.dev')) in front of every context.dev call: the account allows 5 requests in
 * flight, so the semaphore lives here, along with backend pauses and the daily credit totals.
 */
export class ContextDevGate {
  private readonly storage: DurableObjectStorage;
  readonly semaphore: Semaphore;

  constructor(state: DurableObjectState, _env: unknown) {
    this.storage = state.storage;
    this.semaphore = new Semaphore(CONTEXT_DEV_CONCURRENCY, LEASE_MS);
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);
    const body = request.method === 'POST' ? ((await request.json()) as Record<string, unknown>) : {};
    switch (pathname) {
      case '/acquire':
        return Response.json(await this.semaphore.acquire(Math.min(Number(body.waitMs) || QUEUE_WAIT_MS, 10_000)));
      case '/release':
        this.semaphore.release(String(body.lease));
        if (body.usage) await this.record(body.usage as UsageEvent);
        return Response.json({ ok: true });
      case '/pause':
        this.semaphore.pause(Number(body.ms) || 0);
        return Response.json({ ok: true });
      case '/state':
        return Response.json({
          inFlight: this.semaphore.inFlight,
          queued: this.semaphore.queued,
          pausedMs: this.semaphore.pausedFor(),
        });
      case '/usage':
        return Response.json({
          days: await this.usage(Math.min(Math.max(Number(searchParams.get('days')) || 30, 1), 90)),
        });
      default:
        return new Response('not found', { status: 404 });
    }
  }

  private async record(event: UsageEvent): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    const key = `usage:${date}`;
    const day = (await this.storage.get<DayUsage>(key)) ?? { date, requests: 0, credits: 0, routes: {}, tokens: {} };
    const credits = Number.isFinite(event.credits) ? event.credits : 0;
    day.requests += 1;
    day.credits += credits;
    add(day.routes, event.route, credits);
    add(day.tokens, event.token, credits);
    await this.storage.put(key, day);
  }

  private async usage(days: number): Promise<DayUsage[]> {
    const stored = await this.storage.list<DayUsage>({ prefix: 'usage:', reverse: true, limit: days });
    return [...stored.values()];
  }
}
