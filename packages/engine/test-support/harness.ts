import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFauxCore, type FauxResponseStep } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';

export interface Harness {
  session: AgentSession;
  faux: ReturnType<typeof createFauxCore>;
  cwd: string;
  dispose(): void;
}

const created: string[] = [];
process.on('exit', () => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

export async function createHarness(opts: {
  extensions: ExtensionFactory[];
  responses: FauxResponseStep[];
  tools?: string[];
}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'oms-engine-test-'));
  created.push(dir);
  const faux = createFauxCore({ api: 'oms-faux', provider: 'oms-faux', models: [{ id: 'oms-faux-1' }] });
  faux.setResponses(opts.responses);

  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, 'auth.json'),
    modelsPath: null,
  });
  modelRuntime.registerProvider('oms-faux', {
    api: faux.api,
    apiKey: 'faux-not-a-real-key',
    baseUrl: 'http://127.0.0.1:0',
    streamSimple: faux.streamSimple as never,
    models: faux.models.map((m) => ({
      type: 'chat' as const,
      id: m.id,
      name: m.name,
      reasoning: false,
      input: ['text' as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow ?? 128000,
      maxTokens: m.maxTokens ?? 8192,
    })),
  });
  const model = modelRuntime.getModel('oms-faux', 'oms-faux-1');
  if (!model) throw new Error('faux model not registered');

  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: join(dir, 'agent'),
    extensionFactories: opts.extensions,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  } as never);
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: join(dir, 'agent'),
    model,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } } as never),
    ...(opts.tools ? { tools: opts.tools } : {}),
  } as never);
  await session.bindExtensions({} as never);

  return { session, faux, cwd: dir, dispose: () => session.dispose() };
}
