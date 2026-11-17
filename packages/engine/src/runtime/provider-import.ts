import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { parseEnv } from 'node:util';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AuthInteraction, AuthPrompt, LoginOptions } from '@earendil-works/pi-ai';
import { assertPrivate } from '../workspace/storage.ts';
import {
  readInferencePreferences,
  writeInferencePreferences,
  TOKEN_PLAN_PROVIDERS,
  type TokenPlanProvider,
  type MimoProvider,
} from './inference-preferences.ts';

const BINDINGS = {
  OPENAI_API_KEY: 'openai',
  ANTHROPIC_API_KEY: 'anthropic',
  OPENCODE_API_KEY: 'opencode',
  XIAOMI_API_KEY: 'xiaomi',
  XIAOMI_MIMO_TP_API_KEY: null,
} as const;
type EnvironmentName = keyof typeof BINDINGS;
export interface ImportOutcome {
  name: EnvironmentName;
  provider: string | null;
  status: 'not_attempted' | 'configured' | 'may_have_saved';
}
export interface ImportSummary {
  status: 'completed' | 'cancelled' | 'stopped';
  outcomes: ImportOutcome[];
}
export interface ImportOptions {
  interaction?: AuthInteraction;
  tokenPlanProvider?: TokenPlanProvider;
  mimoProvider?: MimoProvider;
  checkAuthFile?(): void;
  flushSettings?(): Promise<void>;
  preferencesPath?: string;
  loginOptions?: LoginOptions;
}
interface Snapshot {
  names: EnvironmentName[];
  values: Record<string, string | undefined>;
}

function preflight(path: string): Snapshot {
  let fd: number | undefined;
  try {
    assertPrivate(path, false);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o7777) !== 0o600 ||
      before.nlink !== 1 ||
      before.size > 65536
    )
      throw new Error();
    // A fixed-size read also bounds an adversarial file that grows after fstat.
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) throw new Error();
    if (
      size > 65536 ||
      size !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
    // parseEnv deliberately accepts duplicate and malformed assignments. Scan complete
    // assignments first, including quoted multiline values, before its normalization.
    const assignment =
      /[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:"[^"]*"[ \t]*(?:#[^\r\n]*)?|'[^']*'[ \t]*(?:#[^\r\n]*)?|[^"' \t\r\n][^\r\n]*|)(?:\r?\n|$)/y;
    const names: EnvironmentName[] = [];
    let cursor = 0;
    while (cursor < text.length) {
      const gap = /^[ \t\r\n]*(?:#[^\r\n]*(?:\r?\n|$))?/.exec(text.slice(cursor))![0];
      if (gap.length) {
        cursor += gap.length;
        continue;
      }
      assignment.lastIndex = cursor;
      const match = assignment.exec(text);
      if (!match) throw new Error();
      const name = match[1]!;
      if (Object.hasOwn(BINDINGS, name)) {
        if (names.includes(name as EnvironmentName)) throw new Error();
        names.push(name as EnvironmentName);
      }
      cursor = assignment.lastIndex;
    }
    const values = parseEnv(text);
    for (const value of Object.values(values)) {
      if (typeof value !== 'string' || /[$`\p{Cc}\p{Cf}]/u.test(value) || value.startsWith('!')) throw new Error();
    }
    for (const name of names) {
      const value = values[name];
      if (!value || value.length > 16384 || /\s/u.test(value)) throw new Error();
    }
    if (!names.length) throw new Error();
    return { names, values };
  } catch {
    throw new Error(
      'Import requires an owned regular 0600 file up to 64 KiB with unique, literal provider keys and valid environment syntax',
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Disclosure only: never returns credentials, ignored names, paths or parser errors. */
export async function inspectProviderEnvironment(
  path: string,
): Promise<{ names: readonly EnvironmentName[]; requiresTokenPlanRegion: boolean }> {
  const snapshot = preflight(path);
  return { names: snapshot.names, requiresTokenPlanRegion: snapshot.names.includes('XIAOMI_MIMO_TP_API_KEY') };
}

async function cancellable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  // ES2023 is the repository baseline; Promise.withResolvers is unavailable.
  const cancellation = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Import cancelled'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([operation(), cancellation]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

function prompt(interaction: AuthInteraction, value: AuthPrompt, signal: AbortSignal): Promise<string> {
  const combined = value.signal ? AbortSignal.any([signal, value.signal]) : signal;
  return cancellable(() => interaction.prompt({ ...value, signal: combined }), combined);
}

/** Explicit operator action; never called automatically when opening a project.
 * Without interaction, the caller owns confirmation. Interactive disclosure and
 * import use one in-memory snapshot, so a changed path cannot change the keys.
 */
export async function importProviderEnvironment(
  path: string,
  runtime: ModelRuntime,
  signal: AbortSignal,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const snapshot = preflight(path);
  const outcomes: ImportOutcome[] = snapshot.names.map((name) => ({
    name,
    provider: BINDINGS[name],
    status: 'not_attempted',
  }));
  const result = (status: ImportSummary['status']): ImportSummary => ({ status, outcomes });
  const combined = options.interaction?.signal ? AbortSignal.any([signal, options.interaction.signal]) : signal;
  if (combined.aborted) return result('cancelled');
  let region = options.tokenPlanProvider;
  const tp = outcomes.find((value) => value.name === 'XIAOMI_MIMO_TP_API_KEY');
  if (tp && !region && options.interaction) {
    try {
      const selected = await prompt(
        options.interaction,
        {
          type: 'select',
          message:
            'Choose the Xiaomi Token Plan region explicitly. Admission uses PAYG-equivalent prices, not subscription billing; there is no PAYG fallback.',
          options: [...TOKEN_PLAN_PROVIDERS.map((id) => ({ id, label: id })), { id: 'cancel', label: 'Cancel' }],
        },
        combined,
      );
      if (selected === 'cancel' || combined.aborted) return result('cancelled');
      region = selected as TokenPlanProvider;
    } catch {
      return result(combined.aborted ? 'cancelled' : 'stopped');
    }
  }
  if (tp) {
    if (!region || !TOKEN_PLAN_PROVIDERS.includes(region))
      throw new Error('Select an explicit canonical Xiaomi Token Plan regional provider before importing');
    tp.provider = region;
  }
  let mimoSelection = options.mimoProvider;
  const hasPayg = outcomes.some((value) => value.name === 'XIAOMI_API_KEY');
  if (tp && hasPayg && !mimoSelection && options.interaction) {
    try {
      const answer = await prompt(
        options.interaction,
        {
          type: 'select',
          message:
            'Both MiMo credential classes are present. Choose the local routing source; no automatic failover is permitted.',
          options: [
            { id: 'xiaomi', label: 'Xiaomi PAYG' },
            { id: region!, label: region! },
            { id: 'cancel', label: 'Cancel' },
          ],
        },
        combined,
      );
      if (answer === 'cancel' || combined.aborted) return result('cancelled');
      mimoSelection = answer as MimoProvider;
    } catch {
      return result(combined.aborted ? 'cancelled' : 'stopped');
    }
  }
  if (tp && hasPayg && mimoSelection !== 'xiaomi' && mimoSelection !== region) {
    throw new Error('Choose the MiMo routing source explicitly when importing both credential classes');
  }
  if (mimoSelection && mimoSelection !== (hasPayg ? 'xiaomi' : undefined) && mimoSelection !== region) {
    throw new Error('Choose a MiMo routing source included in this import');
  }
  // All provider and preference checks precede any credential operation.
  try {
    for (const outcome of outcomes) {
      if (!outcome.provider || !runtime.getProvider(outcome.provider)?.auth.apiKey?.login) throw new Error();
    }
    if (outcomes.some((value) => value.name.startsWith('XIAOMI_'))) {
      if (!options.preferencesPath) throw new Error();
      readInferencePreferences(options.preferencesPath);
    }
  } catch {
    throw new Error(
      'Import requires available canonical API-key providers and a valid private inference preference path for MiMo',
    );
  }
  if (options.interaction) {
    try {
      const answer = await prompt(
        options.interaction,
        {
          type: 'select',
          message: `Import these provider credentials: ${outcomes.map((value) => `${value.name} → ${value.provider}`).join(', ')}. Existing credentials for these providers will be replaced.`,
          options: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'confirm', label: 'Import credentials' },
          ],
        },
        combined,
      );
      if (answer !== 'confirm' || combined.aborted) return result('cancelled');
    } catch {
      return result(combined.aborted ? 'cancelled' : 'stopped');
    }
  }
  for (const outcome of outcomes) {
    if (combined.aborted) return result('cancelled');
    try {
      options.checkAuthFile?.();
      combined.throwIfAborted();
      let supplied = false;
      // Once login starts, even a thrown synchronization error can follow a save.
      outcome.status = 'may_have_saved';
      await cancellable(
        () =>
          runtime.login(
            outcome.provider!,
            'api_key',
            {
              signal: combined,
              async prompt(request) {
                combined.throwIfAborted();
                request.signal?.throwIfAborted();
                if (supplied || request.type !== 'secret')
                  throw new Error('Provider requires interactive configuration');
                supplied = true;
                return snapshot.values[outcome.name]!;
              },
              // Provider notifications may include raw diagnostics: never project them.
              notify() {},
            },
            options.loginOptions ?? { agentName: 'OMS' },
          ),
        combined,
      );
      combined.throwIfAborted();
      if (!runtime.hasConfiguredAuth(outcome.provider!)) throw new Error();
      options.checkAuthFile?.();
      if (options.flushSettings) await cancellable(options.flushSettings, combined);
      combined.throwIfAborted();
      if (outcome.name.startsWith('XIAOMI_')) {
        const preferences = readInferencePreferences(options.preferencesPath!);
        if (!mimoSelection || mimoSelection === outcome.provider) {
          writeInferencePreferences(options.preferencesPath!, {
            ...preferences,
            mimoProvider: outcome.provider as MimoProvider,
          });
        }
      }
      outcome.status = 'configured';
    } catch {
      return result(combined.aborted ? 'cancelled' : 'stopped');
    }
  }
  return result('completed');
}
