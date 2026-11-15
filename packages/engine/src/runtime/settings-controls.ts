import { mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { SettingsManager, type AgentSession, type SettingsConfig } from '@earendil-works/pi-coding-agent';
import { assertPrivate, isMissing, privateDirectory, readPrivateJson, writePrivateJson } from '../workspace/storage.ts';

type Settings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;
const POLICY: Settings = {
  compaction: { enabled: false },
  cacheWarming: 'off',
  // Turn-level retry only: each retry is a fresh metered dispatch (new reservation and attempt). The SDK's own HTTP retries stay off.
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 3000, provider: { maxRetries: 0 } },
  branchSummary: { skipPrompt: true },
  defaultProjectTrust: 'never',
  packages: [],
  extensions: [],
  skills: [],
  prompts: [],
  themes: [],
  enableSkillCommands: false,
  defaultTools: [],
  enableInstallTelemetry: false,
  enableAnalytics: false,
  images: { blockImages: true },
  doubleEscapeAction: 'none',
  transport: 'sse',
};

function guardedSettings(value: unknown): Settings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid harness settings');
  // These are runtime policy, not user-selectable preferences. Pi saves rebuild its effective settings.
  const settings = { ...value, ...POLICY };
  delete settings.codemode;
  return settings;
}

/** Pi's schema and persistence queue; the storage port enforces private OMS state and never reads project/global host config. */
export function createHarnessSettings(agentDir: string): SettingsManager {
  privateDirectory(agentDir);
  const path = join(agentDir, 'settings.json');
  const manager = SettingsManager.fromStorage(
    {
      withLock(scope, update) {
        if (scope !== 'global') throw new Error('Project settings are disabled for this harness');
        assertPrivate(agentDir, true);
        const lock = `${path}.lock`;
        mkdirSync(lock, { mode: 0o700 });
        try {
          let current: unknown = {};
          try {
            current = readPrivateJson(path);
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
          const next = update(JSON.stringify(guardedSettings(current)));
          if (next !== undefined) writePrivateJson(path, guardedSettings(JSON.parse(next)));
        } finally {
          rmdirSync(lock);
        }
      },
    },
    { projectTrusted: false },
  );
  if (manager.drainErrors().length)
    throw new Error('Private harness settings could not be loaded; inspect local configuration before retrying');
  return manager;
}

export async function flushHarnessSettings(manager: SettingsManager): Promise<void> {
  await manager.flush();
  if (manager.drainErrors().length)
    throw new Error(
      'Harness setting changed for this session but could not be saved; inspect private configuration before retrying',
    );
}

export type HarnessSettingsSnapshot = Pick<
  SettingsConfig,
  'thinkingLevel' | 'availableThinkingLevels' | 'steeringMode' | 'followUpMode' | 'httpIdleTimeoutMs'
> & {
  executionBackend?: 'host' | 'docker';
  supportsThinking: boolean;
  defaultModel: string;
};
export interface HarnessSettingsControls {
  snapshot(): HarnessSettingsSnapshot;
  setThinkingLevel(level: SettingsConfig['thinkingLevel']): Promise<void>;
  setSteeringMode(mode: SettingsConfig['steeringMode']): Promise<void>;
  setFollowUpMode(mode: SettingsConfig['followUpMode']): Promise<void>;
  setHttpIdleTimeoutMs(timeoutMs: number): Promise<void>;
}

/** Only implemented session controls are exposed. Setting a preference never prompts the model. */
export function createHarnessSettingsControls(options: {
  session: AgentSession;
  backend?: 'host' | 'docker';
  withUserOperation<T>(action: () => Promise<T>): Promise<T>;
}): HarnessSettingsControls {
  const { session, withUserOperation } = options;
  const manager = session.settingsManager;
  const change = (apply: () => void) =>
    withUserOperation(async () => {
      apply();
      await flushHarnessSettings(manager);
    });
  const queueMode = (mode: string) => {
    if (mode !== 'all' && mode !== 'one-at-a-time') throw new Error('Choose a supported queue mode');
    return mode;
  };
  return {
    snapshot: () => ({
      ...(options.backend ? { executionBackend: options.backend } : {}),
      thinkingLevel: session.thinkingLevel,
      availableThinkingLevels: session.supportsThinking() ? session.getAvailableThinkingLevels() : [],
      supportsThinking: session.supportsThinking(),
      steeringMode: manager.getSteeringMode(),
      followUpMode: manager.getFollowUpMode(),
      httpIdleTimeoutMs: manager.getHttpIdleTimeoutMs(),
      defaultModel: [manager.getDefaultProvider(), manager.getDefaultModel()].filter(Boolean).join('/') || 'Automatic',
    }),
    setThinkingLevel: (level) =>
      change(() => {
        if (!session.supportsThinking() || !session.getAvailableThinkingLevels().includes(level)) {
          throw new Error('The current model does not support this thinking level');
        }
        session.setThinkingLevel(level, { persist: true });
        if (session.model) manager.setModelThinkingLevel(session.model.provider, session.model.id, level);
      }),
    setSteeringMode: (mode) => change(() => session.setSteeringMode(queueMode(mode))),
    setFollowUpMode: (mode) => change(() => session.setFollowUpMode(queueMode(mode))),
    setHttpIdleTimeoutMs: (timeoutMs) =>
      change(() => {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
          throw new Error('HTTP idle timeout must be a nonnegative millisecond duration');
        }
        manager.setHttpIdleTimeoutMs(timeoutMs);
      }),
  };
}
