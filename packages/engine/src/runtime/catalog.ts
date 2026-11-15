import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  MODEL_CATALOG,
  MIMO_BINDINGS,
  resolveMimoWorker,
  type MimoProvider,
  type TokenRates,
  type WorkerSpec,
} from '@oms/core/catalog';

type ProviderConfig = Parameters<ModelRuntime['registerProvider']>[1];
type ProviderModelConfig = NonNullable<ProviderConfig['models']>[number];

function canonicalRates(rates: TokenRates): Model<Api>['cost'] {
  // Pi requires a numeric write price. The policy's null remains authoritative: a
  // reported unsupported write must be refused by admission, never treated as free.
  return { input: rates.input, output: rates.output, cacheRead: rates.cacheRead, cacheWrite: rates.cacheWrite ?? 0 };
}

function definition(spec: WorkerSpec, original: Model<Api>): ProviderModelConfig {
  return {
    ...original,
    id: spec.modelId,
    name: spec.key === 'terra' ? 'GPT-6.1 Terra' : original.name,
    api: spec.api,
    baseUrl: spec.baseUrl,
    contextWindow: Math.min(original.contextWindow, spec.effectiveContextWindow),
    maxTokens: Math.min(original.maxTokens, spec.maxOutputTokens),
    cost: {
      ...canonicalRates(spec.cost),
      ...(spec.cost.tiers
        ? {
            tiers: spec.cost.tiers.map((tier) => ({
              ...canonicalRates(tier),
              inputTokensAbove: tier.inputTokensAbove,
            })),
          }
        : {}),
    },
  };
}

/** Call before default-model resolution or session restoration. No authentication or network work. */
export function registerOmsCatalog(runtime: ModelRuntime): void {
  const specs = [...Object.values(MODEL_CATALOG)];
  for (const provider of Object.keys(MIMO_BINDINGS) as MimoProvider[]) {
    if (provider === 'xiaomi') continue;
    specs.push(resolveMimoWorker('mimo-pro', provider), resolveMimoWorker('mimo-flash', provider));
  }
  const overlays = new Map<string, ProviderConfig>();
  for (const spec of specs) {
    // registerProvider deliberately replaces native registrations; explicit host overrides keep their auth and transport.
    // A host-registered provider with its own baseUrl (e.g. the bench metering proxy) must never be re-pointed at the vendor.
    if (
      runtime.getRegisteredNativeProvider(spec.provider) ||
      runtime.getRegisteredProviderConfig(spec.provider)?.baseUrl
    )
      continue;
    let overlay = overlays.get(spec.provider);
    if (!overlay) {
      if (!runtime.getProvider(spec.provider)) continue;
      // registerProvider replaces its model array; retain chat, image and classifier
      // definitions, and leave canonical auth/transport composition to the SDK.
      overlay = {
        ...runtime.getRegisteredProviderConfig(spec.provider),
        models: [...runtime.getAllModels(spec.provider)],
      };
      overlays.set(spec.provider, overlay);
    }
    let original = runtime.getPhysicalModel(spec.provider, spec.modelId);
    if (!original && spec.key === 'terra') {
      const sol = runtime.getPhysicalModel('openai', 'gpt-6.1-sol');
      if (!sol) continue;
      // Terra's documented Responses tools/structured outputs and supported efforts:
      // https://developers.openai.com/api/docs/models/gpt-6.1-terra
      original = {
        ...sol,
        thinkingLevelMap: {
          off: 'none',
          minimal: null,
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: 'max',
        },
      };
    }
    if (!original) continue;
    const models = overlay.models!;
    const index = models.findIndex(
      (model) => (model.type === undefined || model.type === 'chat') && model.id === spec.modelId,
    );
    const updated = definition(spec, original);
    if (index === -1) models.push(updated);
    else models[index] = updated;
  }
  for (const [provider, config] of overlays) runtime.registerProvider(provider, config);
}
