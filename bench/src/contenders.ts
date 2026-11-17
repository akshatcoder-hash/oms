import type { Api, Model } from '@earendil-works/pi-ai';
import { getBuiltinModels, getBuiltinProviders, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all';

/** USD per million tokens. */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A private, internal Docker network: its containers can reach only the host on the gateway address. */
export interface BenchNetwork {
  name: string;
  subnet: string;
  gateway: string;
}

/** The online cells' network: the egress tunnel listens only here, so no offline container shares a network with it. */
export const ONLINE_NETWORK: BenchNetwork = { name: 'oms-online', subnet: '172.31.0.0/24', gateway: '172.31.0.1' };

export type Funding = 'api' | 'subscription';

/** Explicit, bounded runtime model metadata; contains no provider credential or endpoint secret. */
export interface ContenderModel {
  provider: string;
  id: string;
  name: string;
  api: 'openai-responses' | 'anthropic-messages' | 'openai-completions';
  reasoning: boolean;
  /** Pi's own thinking-level mapping and provider compat flags for this model, so a cell thinks as the shipped product does. */
  thinkingLevelMap?: Model<Api>['thinkingLevelMap'];
  compat?: Record<string, unknown>;
  contextWindow: number;
  maxTokens: number;
  cost: Rates;
}

/** Thinking support from pi's built-in catalog entry for the physical model; a model pi does not list runs without thinking. */
export function catalogThinking(
  provider: string,
  id: string,
): Pick<ContenderModel, 'reasoning' | 'thinkingLevelMap' | 'compat'> {
  const entry = (getBuiltinProviders() as string[]).includes(provider)
    ? (getBuiltinModels(provider as BuiltinProvider) as Model<Api>[]).find((model) => model.id === id)
    : undefined;
  if (!entry?.reasoning) return { reasoning: false };
  return {
    reasoning: true,
    ...(entry.thinkingLevelMap ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
    ...(entry.compat ? { compat: entry.compat as Record<string, unknown> } : {}),
  };
}
