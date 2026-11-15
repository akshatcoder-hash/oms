// usage: node scripts/gen-program-reference.ts [--check] [--refresh-ranking]
// Regenerates packages/engine/src/runtime/program-reference.json from the pinned sources in scripts/program-reference/sources.ts.
// --check regenerates in memory and fails if the checked-in file differs. --refresh-ranking re-fetches the DefiLlama snapshot that
// scripts/program-reference/ranking.json pins; run it deliberately, then regenerate. OMS_REF_CACHE=<dir> caches downloads by URL.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ProgramReferenceData,
  ReferenceInstruction,
  ReferenceProgram,
} from '../packages/engine/src/runtime/program-reference-data.ts';
import {
  adaptAnchor,
  adaptCodama,
  adaptCountPrefixed,
  adaptPrecompile,
  adaptRustEnum,
  parseJsIdl,
  type Adapted,
} from './program-reference/adapters.ts';
import { APPLICATIONS, NATIVE, STANDALONE, type ClientSpec, type ProgramSpec } from './program-reference/sources.ts';
import { validateProgramReference } from './program-reference/validate.ts';

const OUT = new URL('../packages/engine/src/runtime/program-reference.json', import.meta.url);
const RANKING = new URL('./program-reference/ranking.json', import.meta.url);
const DEX_URL =
  'https://api.llama.fi/overview/dexs/Solana?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true';
const TVL_URL = 'https://api.llama.fi/protocols';
const CACHE = process.env.OMS_REF_CACHE;

async function download(url: string): Promise<string> {
  const cached = CACHE && join(CACHE, createHash('sha256').update(url).digest('hex'));
  if (cached && existsSync(cached)) return readFileSync(cached, 'utf8');
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (cached) {
        mkdirSync(CACHE!, { recursive: true });
        writeFileSync(cached, text);
      }
      return text;
    } catch (error) {
      if (attempt === 4) throw new Error(`${url}: ${(error as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

interface Ranking {
  asOf: string;
  dex: Array<[string, number]>;
  tvl: Array<[string, string, number]>;
}

async function refreshRanking(): Promise<void> {
  const dex = JSON.parse(await download(DEX_URL)).protocols as Array<{ name: string; total30d: number | null }>;
  const tvl = JSON.parse(await download(TVL_URL)) as Array<{
    name: string;
    category: string;
    chainTvls?: Record<string, number>;
  }>;
  const ranking: Ranking = {
    asOf: new Date().toISOString().slice(0, 10),
    dex: dex
      .filter((p) => p.total30d)
      .map((p): [string, number] => [p.name, Math.round(p.total30d!)])
      .sort((a, b) => b[1] - a[1]),
    tvl: tvl
      .filter((p) => p.chainTvls?.Solana !== undefined && p.category !== 'CEX')
      .map((p): [string, string, number] => [p.name, p.category, Math.round(p.chainTvls!.Solana!)])
      .sort((a, b) => b[2] - a[2])
      .slice(0, 250),
  };
  writeFileSync(RANKING, `${JSON.stringify(ranking)}\n`);
  console.log(`ranking snapshot ${ranking.asOf}: ${ranking.dex.length} dex rows, ${ranking.tvl.length} tvl rows`);
}

const usd = (value: number): string =>
  `$${value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : `${Math.round(value / 1e6)}M`}`;

function rankText(spec: ProgramSpec, ranking: Ranking): string | undefined {
  if (!spec.rank) return undefined;
  const rows =
    spec.rank.list === 'dex'
      ? ranking.dex.map(([name, value]) => [name, value] as const)
      : ranking.tvl.map(([name, , value]) => [name, value] as const);
  const index = rows.findIndex(([name]) => name === spec.rank!.name);
  if (index < 0) throw new Error(`${spec.name}: ${spec.rank.name} is not in the ranking snapshot`);
  return spec.rank.list === 'dex'
    ? `DefiLlama Solana DEX volume, 30d: #${index + 1} ${spec.rank.name} (${usd(rows[index]![1])})`
    : `DefiLlama Solana TVL: #${index + 1} ${spec.rank.name} (${usd(rows[index]![1])})`;
}

function adapt(spec: ProgramSpec, text: string): Adapted {
  switch (spec.kind) {
    case 'idl': {
      const idl = JSON.parse(text);
      return idl.kind === 'rootNode' ? adaptCodama(idl) : adaptAnchor(idl);
    }
    case 'idl-count':
      return adaptCountPrefixed(JSON.parse(text));
    case 'idl-js':
      return adaptAnchor(parseJsIdl(text));
    case 'rust-enum':
      return adaptRustEnum(text, spec.rust!.enumName!, spec.rust!.width!);
    case 'precompile':
      return adaptPrecompile(text, spec.rust!.offsetsStruct!);
  }
}

/** Only plain facts survive for a source outside the licence allowlist: names, order, discriminators. */
const factsOnly = (ix: ReferenceInstruction): ReferenceInstruction => ({
  name: ix.name,
  ...(ix.alias ? { alias: ix.alias } : {}),
  discriminator: ix.discriminator,
  accounts: ix.accounts.map((a) => ({ name: a.name })),
});

/** A client is recorded only when its exact npm version exists under that name and the pinned evidence document names it. */
async function verifyClient(spec: ProgramSpec, client: ClientSpec): Promise<string> {
  const manifest = JSON.parse(
    await download(`https://cdn.jsdelivr.net/npm/${client.package}@${client.version}/package.json`),
  );
  if (manifest.name !== client.package || manifest.version !== client.version)
    throw new Error(
      `${spec.name}: npm has ${manifest.name}@${manifest.version}, not ${client.package}@${client.version}`,
    );
  const needle = client.needle ?? client.package;
  if (!(await download(client.evidence)).includes(needle))
    throw new Error(`${spec.name}: ${client.evidence} does not mention ${needle}`);
  return client.package;
}

async function build(
  spec: ProgramSpec,
  category: ReferenceProgram['category'],
  ranking: Ranking,
): Promise<{ program: ReferenceProgram; confirmations: number }> {
  const adapted = adapt(spec, await download(spec.url));
  if (adapted.address && adapted.address !== (spec.idlAddress ?? spec.id))
    throw new Error(`${spec.name}: IDL address ${adapted.address} differs from ${spec.idlAddress ?? spec.id}`);
  for (const url of spec.idSources)
    if (!(await download(url)).includes(spec.id)) throw new Error(`${spec.name}: ${url} does not contain ${spec.id}`);
  const rank = rankText(spec, ranking);
  const clients = [...new Set(await Promise.all((spec.clients ?? []).map((client) => verifyClient(spec, client))))];
  const program: ReferenceProgram = {
    name: spec.name,
    id: spec.id,
    category,
    purpose: spec.purpose,
    ...(spec.indexHint ? { indexHint: spec.indexHint } : {}),
    ...(STANDALONE.has(spec.name) ? { standalone: true as const } : {}),
    style: adapted.style,
    source: { url: spec.url, version: spec.version, licence: spec.licence },
    ...(clients.length ? { clients } : {}),
    ...(adapted.count ? { count: adapted.count } : {}),
    ...(spec.factsOnly ? { factsOnly: true as const } : {}),
    ...(rank ? { rank } : {}),
    instructions: spec.factsOnly ? adapted.instructions.map(factsOnly) : adapted.instructions,
  };
  return { program, confirmations: spec.idSources.length + (adapted.address && !spec.idlAddress ? 1 : 0) };
}

/** One instruction per line keeps the checked-in file reviewable. */
function format(data: ProgramReferenceData): string {
  const programs = data.programs.map(
    ({ instructions, ...head }) =>
      `${JSON.stringify(head).slice(0, -1)},"instructions":[\n${instructions.map((ix) => `  ${JSON.stringify(ix)}`).join(',\n')}\n]}`,
  );
  const { programs: _omit, ...top } = data;
  return `${JSON.stringify(top).slice(0, -1)},"programs":[\n${programs.join(',\n')}\n]}\n`;
}

if (process.argv.includes('--refresh-ranking')) {
  await refreshRanking();
  process.exit(0);
}

const ranking = JSON.parse(readFileSync(RANKING, 'utf8')) as Ranking;
const SPECS = [
  ...NATIVE.map((spec) => [spec, 'native'] as const),
  ...APPLICATIONS.map((spec) => [spec, 'application'] as const),
];
const settled = await Promise.allSettled(
  SPECS.map(([spec, category]) =>
    build(spec, category, ranking).catch((error: Error) => {
      throw error.message.startsWith(spec.name) ? error : new Error(`${spec.name}: ${error.message}`);
    }),
  ),
);
const failures = settled.filter((r) => r.status === 'rejected').map((r) => (r.reason as Error).message);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
const built = settled.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof build>>>).value);
const data: ProgramReferenceData = {
  schema: 'oms.program-reference/1',
  generator: 'scripts/gen-program-reference.ts',
  ranking: {
    source: `DefiLlama public API (${DEX_URL} and ${TVL_URL})`,
    asOf: ranking.asOf,
    method:
      'Application programs are on the list when DefiLlama ranks them in its Solana DEX 30-day volume or Solana TVL tables (scripts/program-reference/ranking.json is the pinned snapshot) and a public interface source could be read; infrastructure programs (oracles, NFT standards, multisig) have no row in those tables and carry no rank. DefiLlama measures value and volume, not instruction counts.',
  },
  programs: built.map((b) => b.program),
};
const problems = validateProgramReference(data);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
const text = format(data);
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('program-reference.json is stale: run node scripts/gen-program-reference.ts');
    process.exit(1);
  }
  console.log('program-reference.json matches its sources');
} else {
  writeFileSync(OUT, text);
  console.log(
    `wrote ${data.programs.length} programs, ${data.programs.reduce((n, p) => n + p.instructions.length, 0)} instructions, ${text.length} bytes`,
  );
}
for (const { program, confirmations } of built)
  if (confirmations < 2) console.log(`id has ${confirmations} confirming source(s): ${program.name}`);
