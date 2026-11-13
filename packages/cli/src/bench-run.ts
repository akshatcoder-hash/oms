import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { parseRunRecord, registerOmsCatalog, SEARCH_BACKENDS, type RunRecord } from '@oms/engine';
import type { ContenderModel } from '../../engine/src/bench/contenders.ts';
import type { CodexCredential } from '../../engine/src/bench/subscription.ts';
import { parseContender } from '../../engine/src/bench/matrix.ts';
import { omsBase } from '../../engine/src/runtime/web.ts';
import { runHarnessCommand } from './harness.ts';

export interface OmsContenderRun {
  /** Cell id, for example `oms3-web:gpt-sol`. */
  contender: string;
  runIndex: number;
  selection: { provider: string; id: string };
  /** Explicit model metadata for the cell; the subscription path uses the SDK catalog entry instead. */
  modelDefinition?: ContenderModel;
  /** The ChatGPT (Codex) subscription login OMS signs in with. */
  subscriptionCredential: CodexCredential;
  jsonOut: string;
  /** Headless `oms run` arguments other than provider, model and JSON output. */
  args: string[];
}

/**
 * The record's `online` label, from the contender id. An online cell launched without --web would carry the wrong label,
 * so it refuses before the run.
 */
export function onlineStamp(contender: string, args: readonly string[]): Pick<RunRecord, 'online'> {
  const online = parseContender(contender)?.online;
  if (Boolean(online) !== args.includes('--web')) throw new Error(`${contender} ${online ? 'needs' : 'must not get'} --web`);
  return online ? { online } : {};
}

/**
 * `--web` for the online OMS cell, on the hosted oms-search stack only: a bring-your-own search key in the environment would add
 * a backend the cell's label does not name, and a missing or non-loopback/https OMS_SEARCH_URL would leave web_search without one.
 * Credentials come from OMS_SEARCH_URL and OMS_SEARCH_TOKEN.
 */
export function omsWebArgs(contender: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!parseContender(contender)?.online) return [];
  if (!env.OMS_SEARCH_TOKEN || !omsBase(env.OMS_SEARCH_URL)) {
    throw new Error(`${contender} needs OMS_SEARCH_TOKEN and an https: or loopback OMS_SEARCH_URL (the oms-search stack)`);
  }
  const byok = SEARCH_BACKENDS.filter(backend => backend.name !== 'oms' && env[backend.key]).map(backend => backend.key);
  if (byok.length) throw new Error(`${contender} searches through oms-search only; unset ${byok.join(', ')}`);
  return ['--web'];
}

/** Runs one OMS cell through the production headless path, signed in to the Codex subscription. */
export async function runOmsContender(o: OmsContenderRun): Promise<number> {
  const stamp = onlineStamp(o.contender, o.args);
  const scratch = mkdtempSync(join(tmpdir(), 'oms-contender-'));
  try {
    const authPath = join(scratch, 'auth.json');
    writeFileSync(authPath, JSON.stringify({ 'openai-codex': o.subscriptionCredential }), { mode: 0o600 });
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    if (!o.args.includes('--task') || !o.args[o.args.indexOf('--task') + 1]) throw new Error('Cell runs need --task');
    registerOmsCatalog(runtime);
    const model = runtime.getModel(o.selection.provider, o.selection.id);
    if (!model) throw new Error(`Unknown model ${o.selection.provider}/${o.selection.id}`);
    const headlessOut = join(scratch, 'record.json');
    const exitCode = await runHarnessCommand('run', ['--headless', ...o.args, '--subscription-spend-exempt',
      '--provider', model.provider, '--model', model.id, '--json-out', headlessOut], { modelRuntime: runtime });
    const record = parseRunRecord({ ...JSON.parse(readFileSync(headlessOut, 'utf8')),
      contender: o.contender, runIndex: o.runIndex, funding: 'subscription', ...stamp });
    mkdirSync(dirname(o.jsonOut), { recursive: true, mode: 0o700 });
    writeFileSync(o.jsonOut, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return exitCode;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
