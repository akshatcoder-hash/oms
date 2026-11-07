export const MODEL_POLICY_VERSION = '2026-11-07.1';

export type WorkerKey = 'sol' | 'astra' | 'terra' | 'sonnet' | 'opus' | 'haiku'
  | 'mimo-pro' | 'mimo-flash' | 'deepseek-pro' | 'deepseek-flash' | 'grok' | 'grok-build'
  | 'muse-spark' | 'muse-wonder';
export type MimoProvider = 'xiaomi' | 'xiaomi-token-plan-cn' | 'xiaomi-token-plan-sgp' | 'xiaomi-token-plan-ams';
export type CatalogProvider = 'openai' | 'anthropic' | 'opencode' | MimoProvider;

/** USD per million tokens. Null means unsupported, never a free receipt category. */
export interface TokenRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number | null;
  readonly cacheWriteLong?: number;
}
export interface CostTier extends TokenRates {
  /** Input plus cached tokens; the tier applies to the entire request above this threshold. */
  readonly inputTokensAbove: number;
}
export interface WorkerCost extends TokenRates {
  readonly tiers?: readonly CostTier[];
}
export interface CachePolicy {
  readonly write: 'priced' | 'temporary-free' | 'unsupported';
  /** Empty means no caller-selected write lifetime is supported. */
  readonly writeTtlSeconds: readonly number[];
  readonly sourceUrl: string;
}
export interface WorkerSpec {
  readonly key: WorkerKey;
  readonly provider: CatalogProvider;
  readonly modelId: string;
  readonly api: 'openai-responses' | 'anthropic-messages' | 'openai-completions';
  readonly baseUrl: string;
  readonly publishedContextWindow: number;
  readonly effectiveContextWindow: number;
  readonly maxOutputTokens: number;
  readonly cost: WorkerCost;
  readonly cachePolicy: CachePolicy;
  readonly credentialClass: 'payg' | 'token-plan';
  readonly lifecycle: 'active';
  readonly sourceUrl: string;
  readonly pricingSourceUrl: string;
  readonly windowSource: string;
  readonly verifiedAt: '2026-11-01';
}

function freeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) {
    if (nested !== null && typeof nested === 'object' && !Object.isFrozen(nested)) freeze(nested);
  }
  return Object.freeze(value);
}

const OPENAI_PRICING = 'https://developers.openai.com/api/docs/pricing';
const ANTHROPIC_MODELS = 'https://platform.claude.com/docs/en/about-claude/models/overview';
const ANTHROPIC_PRICING = 'https://platform.claude.com/docs/en/about-claude/pricing';
const MIMO_MODELS = 'https://mimo.mi.com/static/docs/quick-start/summary/model.md';
const MIMO_PRICING = 'https://mimo.mi.com/static/docs/price/pay-as-you-go.md';
const OPENCODE_MODELS = 'https://opencode.ai/v2/docs/console/models/';
const OPENCODE_WINDOWS = '@earendil-works/pi-ai@1.4.0/providers/data/opencode.json';

function spec(value: Omit<WorkerSpec, 'credentialClass' | 'lifecycle' | 'verifiedAt'>): WorkerSpec {
  return freeze({ ...value, credentialClass: 'payg', lifecycle: 'active', verifiedAt: '2026-11-01' });
}
function openai(key: 'sol' | 'astra' | 'terra', modelId: string, rates: TokenRates): WorkerSpec {
  const sourceUrl = `https://developers.openai.com/api/docs/models/${modelId}`;
  return spec({ key, modelId, provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1',
    publishedContextWindow: 1_050_000, effectiveContextWindow: 272_000, maxOutputTokens: 128_000,
    cost: { ...rates, tiers: [{ inputTokensAbove: 272_000, input: rates.input * 2, output: rates.output * 1.5,
      cacheRead: rates.cacheRead * 2, cacheWrite: rates.cacheWrite! * 2 }] },
    cachePolicy: { write: 'priced', writeTtlSeconds: [1800], sourceUrl: 'https://developers.openai.com/api/docs/guides/prompt-caching' },
    sourceUrl, pricingSourceUrl: OPENAI_PRICING, windowSource: sourceUrl });
}
function anthropic(key: 'sonnet' | 'opus' | 'haiku', cost: WorkerCost): WorkerSpec {
  return spec({ key, modelId: `claude-${key}-5-5`, provider: 'anthropic', api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com', publishedContextWindow: 1_000_000, effectiveContextWindow: 1_000_000,
    maxOutputTokens: 128_000, cost,
    cachePolicy: { write: 'priced', writeTtlSeconds: [300, 3600], sourceUrl: ANTHROPIC_PRICING },
    sourceUrl: ANTHROPIC_MODELS, pricingSourceUrl: ANTHROPIC_PRICING, windowSource: ANTHROPIC_MODELS });
}
function mimo(key: 'mimo-pro' | 'mimo-flash', cost: WorkerCost): WorkerSpec {
  return spec({ key, modelId: key === 'mimo-pro' ? 'mimo-v2.6-pro' : 'mimo-v2.6-flash',
    provider: 'xiaomi', api: 'openai-completions', baseUrl: 'https://api.xiaomimimo.com/v1',
    // Published 1M/128K are kept conservative rather than expanding to the SDK's binary units.
    publishedContextWindow: 1_000_000, effectiveContextWindow: 1_000_000, maxOutputTokens: 128_000, cost,
    cachePolicy: { write: 'temporary-free', writeTtlSeconds: [], sourceUrl: MIMO_PRICING },
    sourceUrl: MIMO_MODELS, pricingSourceUrl: MIMO_PRICING, windowSource: MIMO_MODELS });
}
function opencode(key: WorkerKey, modelId: string, window: number,
  output: number, cost: WorkerCost): WorkerSpec {
  return spec({ key, modelId, provider: 'opencode',
    api: key.startsWith('deepseek') ? 'openai-completions' : 'openai-responses',
    baseUrl: 'https://opencode.ai/inference/openai/v1', publishedContextWindow: window,
    effectiveContextWindow: window, maxOutputTokens: output, cost,
    cachePolicy: { write: 'unsupported', writeTtlSeconds: [], sourceUrl: OPENCODE_MODELS },
    sourceUrl: OPENCODE_MODELS, pricingSourceUrl: OPENCODE_MODELS, windowSource: OPENCODE_WINDOWS });
}

/** Reviewed policy over canonical models; not an authentication or provider registry. */
export const MODEL_CATALOG: Readonly<Record<WorkerKey, WorkerSpec>> = freeze({
  sol: openai('sol', 'gpt-6.1-sol', { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }),
  astra: openai('astra', 'gpt-6-astra', { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }),
  terra: openai('terra', 'gpt-6.1-terra', { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 }),
  sonnet: anthropic('sonnet', { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWriteLong: 4 }),
  opus: anthropic('opus', { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWriteLong: 8 }),
  haiku: anthropic('haiku', { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWriteLong: 0.2,
    tiers: [{ inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWriteLong: 1 }] }),
  'mimo-pro': mimo('mimo-pro', { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 }),
  'mimo-flash': mimo('mimo-flash', { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 }),
  'deepseek-pro': opencode('deepseek-pro', 'deepseek-v4-pro', 1_000_000, 384_000,
    { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: null }),
  'deepseek-flash': opencode('deepseek-flash', 'deepseek-v4.1-flash', 1_000_000, 384_000,
    { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: null }),
  grok: opencode('grok', 'grok-4.7', 500_000, 500_000,
    { input: 2, output: 6, cacheRead: 0.5, cacheWrite: null,
      tiers: [{ inputTokensAbove: 200_000, input: 4, output: 12, cacheRead: 1, cacheWrite: null }] }),
  'grok-build': opencode('grok-build', 'grok-build-0.1', 256_000, 256_000,
    { input: 1, output: 2, cacheRead: 0.2, cacheWrite: null }),
  'muse-spark': opencode('muse-spark', 'muse-spark-1.3', 1_048_576, 131_072,
    { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: null }),
  'muse-wonder': opencode('muse-wonder', 'muse-wonder-1.0', 1_048_576, 131_072,
    { input: 4, output: 20, cacheRead: 0.2, cacheWrite: null }),
});

interface MimoBinding {
  readonly baseUrl: string;
  readonly credentialClass: 'payg' | 'token-plan';
  readonly admissionDisclosure: string;
  readonly sourceUrl: string;
}
const tokenPlanDisclosure = 'Local Token Plan uses PAYG-equivalent admission estimates, not subscription billing. Regional entitlement is required; no automatic PAYG spillover.';
const tokenPlanSource = 'https://mimo.mi.com/static/docs/tokenplan/Token%20Plan/subscription.md';
export const MIMO_BINDINGS: Readonly<Record<MimoProvider, MimoBinding>> = freeze({
  xiaomi: { baseUrl: 'https://api.xiaomimimo.com/v1', credentialClass: 'payg',
    admissionDisclosure: 'PAYG-equivalent admission uses published overseas API token prices; actual invoices may differ.', sourceUrl: MIMO_PRICING },
  'xiaomi-token-plan-cn': { baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', credentialClass: 'token-plan',
    admissionDisclosure: tokenPlanDisclosure, sourceUrl: tokenPlanSource },
  'xiaomi-token-plan-sgp': { baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1', credentialClass: 'token-plan',
    admissionDisclosure: tokenPlanDisclosure, sourceUrl: tokenPlanSource },
  'xiaomi-token-plan-ams': { baseUrl: 'https://token-plan-ams.xiaomimimo.com/v1', credentialClass: 'token-plan',
    admissionDisclosure: tokenPlanDisclosure, sourceUrl: tokenPlanSource },
});

/** Managed callers explicitly select xiaomi; local callers supply their persisted choice. */
export function resolveMimoWorker(key: 'mimo-pro' | 'mimo-flash', provider: MimoProvider | null): WorkerSpec {
  if (provider === null || !Object.hasOwn(MIMO_BINDINGS, provider)) throw new Error('MiMo configuration required: explicitly select PAYG or a regional Token Plan provider');
  if (provider === 'xiaomi') return MODEL_CATALOG[key];
  const binding = MIMO_BINDINGS[provider];
  return freeze({ ...MODEL_CATALOG[key], provider, baseUrl: binding.baseUrl, credentialClass: binding.credentialClass });
}
