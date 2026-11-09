import { posix } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import type { ReviewSnapshot } from './snapshot.ts';
import type { StaticExecutionPort } from './static/run.ts';
import { validLocation } from './types.ts';

const name = Type.String({ minLength: 1, maxLength: 256 });
const Framework = Type.Union([Type.Literal('anchor'), Type.Literal('native'), Type.Literal('pinocchio')]);
const Manifest = Type.Object({ name: Type.Union([name, Type.Null()]), framework: Type.Union([Framework, Type.Null()]),
  libPath: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false });
const Handler = Type.Object({ name, file: Type.String({ minLength: 1, maxLength: 4096 }),
  line: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  accountStruct: Type.Optional(Type.Object({ file: Type.String({ minLength: 1, maxLength: 4096 }),
    line: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    endLine: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }, { additionalProperties: false })),
}, { additionalProperties: false });
const Source = Type.Object({ programIds: Type.Array(name, { maxItems: 100 }),
  handlers: Type.Array(Handler, { maxItems: 10000 }) }, { additionalProperties: false });
export interface DiscoveredProgram {
  name: string;
  programId: string;
  framework: Static<typeof Framework>;
  manifest: string;
  sources: string[];
  handlers: Array<Static<typeof Handler>>;
  handlerSource: 'idl' | 'syntax';
  idl?: string;
}
export interface DiscoveryResult {
  programs: DiscoveredProgram[];
  /** `manifest` is the Cargo manifest whose inventory recorded the issue. */
  issues: Array<{ file: string; reason: string; manifest: string }>;
}
/** True when a Cargo.toml declares a workspace (`[workspace]` or a `workspace.*` table). */
export function declaresCargoWorkspace(manifest: string): boolean {
  return /^\s*\[workspace[\].]/m.test(manifest);
}
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function programKey(key: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key)) return false;
  let n = 0n;
  for (const c of key) n = n * 58n + BigInt(alphabet.indexOf(c));
  let bytes = key.match(/^1*/)?.[0].length ?? 0;
  while (n > 0n) { bytes++; n >>= 8n; }
  return bytes === 32;
}
function relativePath(path: string): boolean {
  return !/[\\:\x00-\x1f\x7f]/.test(path) && path.split('/').every(p => p && p !== '.' && p !== '..');
}
const normalize = (name: string) => name.replace(/_/g, '').toLowerCase();

/** Inspect captured files only. Cargo metadata/build scripts and project code are
 * never executed. Frameworks are direct-dependency syntax, not type resolution.
 * In the absence of a matching IDL every free function is a review candidate;
 * that fallback does not assert that helpers are on-chain entrypoints. */
export async function discoverPrograms(snapshot: ReviewSnapshot, port: StaticExecutionPort,
  now: () => number = () => performance.now()): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { programs: [], issues: [] };
  const inventory = snapshot.inventory();
  const paths = [...inventory.keys()].sort();
  if (paths.length > 2000 || paths.some(file => !validLocation({ file, line: 1 }, inventory))) {
    throw new Error('Invalid discovery snapshot');
  }
  // Freeze inputs before asynchronous ports run.
  const captured = new Map(paths.filter(p => p.endsWith('.rs') || p.endsWith('.json') || posix.basename(p) === 'Cargo.toml')
    .map(p => [p, snapshot.read(p)]));
  const manifests = paths.filter(p => posix.basename(p) === 'Cargo.toml');
  const deadline = now() + 300000;
  let remainingBytes = 16 * 1024 * 1024;
  const issue = (file: string, reason: string, manifest = file) => { result.issues.push({ file, reason, manifest }); };
  async function inspect(file: string): Promise<unknown> {
    const timeoutMs = Math.floor(deadline - now());
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || remainingBytes <= 0) throw new Error('budget');
    const outputBytes = Math.min(remainingBytes, 4 * 1024 * 1024);
    remainingBytes -= outputBytes;
    const response = await port.run({ tool: 'oms-sast', argv: ['oms-sast', '--inventory', file],
      files: new Map([[file, captured.get(file)!]]), cwd: '/work', network: 'none', readOnly: true,
      timeoutMs: Math.min(timeoutMs, 300000), outputBytes });
    const bytes = Buffer.byteLength(response.stdout);
    if (bytes > outputBytes) { remainingBytes = 0; throw new Error('oversized'); }
    remainingBytes += outputBytes - bytes;
    if (response.exitCode !== 0 || response.timedOut || response.truncated) throw new Error('failed');
    return JSON.parse(response.stdout);
  }
  for (const manifest of manifests) {
    let metadata: Static<typeof Manifest>;
    try {
      const value = await inspect(manifest);
      if (!Value.Check(Manifest, value)) throw new Error('schema');
      metadata = value;
    } catch { issue(manifest, 'Manifest inventory unavailable'); continue; }
    if (!metadata.name) continue; // virtual Cargo workspace
    if (!metadata.framework) { issue(manifest, 'Framework unresolved from direct dependencies'); continue; }
    if (!relativePath(metadata.libPath)) { issue(manifest, 'Library path is outside the supported scope'); continue; }
    const root = posix.dirname(manifest);
    const prefix = root === '.' ? '' : root + '/';
    const lib = prefix + metadata.libPath;
    if (!inventory.has(lib)) { issue(manifest, 'Library source absent from snapshot'); continue; }
    const nested = manifests.filter(p => p !== manifest && p.startsWith(prefix)).map(p => posix.dirname(p) + '/');
    const sources = paths.filter(p => p.startsWith(prefix) && p.endsWith('.rs') && !nested.some(dir => p.startsWith(dir)) &&
      // Tests/examples/build scripts are not program handlers. Module graphs and
      // cfg expansion remain unresolved; include the library's source directory.
      p.startsWith(posix.dirname(lib) === '.' ? '' : posix.dirname(lib) + '/') &&
      !['tests', 'examples', 'benches'].includes(p.slice(prefix.length).split('/')[0]!) && p !== prefix + 'build.rs');
    const ids = new Set<string>();
    const handlers: DiscoveredProgram['handlers'] = [];
    let incomplete = false;
    for (const file of sources) {
      try {
        const value = await inspect(file);
        if (!Value.Check(Source, value) || value.programIds.some(id => !programKey(id)) ||
            value.handlers.some(h => h.file !== file || !validLocation(h, inventory) ||
              (h.accountStruct && (h.accountStruct.file !== file || !validLocation(h.accountStruct, inventory))))) throw new Error('schema');
        // A library's declaration binds its identity. Other modules can declare
        // dependency IDs; they must not replace the target's address.
        if (file === lib) for (const id of value.programIds) ids.add(id);
        handlers.push(...value.handlers);
      } catch { incomplete = true; issue(file, 'Rust inventory unavailable', manifest); }
    }
    if (ids.size !== 1) { issue(manifest, 'Library must declare exactly one program ID'); continue; }
    const program: DiscoveredProgram = { name: metadata.name, programId: [...ids][0]!, framework: metadata.framework,
      manifest, sources, handlers, handlerSource: 'syntax' };
    const matching: Array<{ file: string; names: string[] }> = [];
    for (const [file, text] of captured) {
      if (!file.endsWith('.json')) continue;
      let idl: unknown;
      try { idl = JSON.parse(text); } catch { continue; }
      if (!idl || typeof idl !== 'object' || Array.isArray(idl)) continue;
      const obj = idl as Record<string, unknown>;
      const meta = obj['metadata'];
      const address = obj['address'] ?? (meta && typeof meta === 'object' ? (meta as Record<string, unknown>)['address'] : undefined);
      if (address !== program.programId) continue;
      const instructions = obj['instructions'];
      if (!Array.isArray(instructions) || !instructions.length || instructions.length > 10000 ||
          instructions.some(i => !i || typeof i !== 'object' || !Value.Check(name, i.name))) {
        issue(file, 'Matching IDL has invalid instructions', manifest); continue;
      }
      matching.push({ file, names: instructions.map(i => i.name as string) });
    }
    if (matching.length === 1 && !incomplete) {
      const idl = matching[0]!;
      const selected = idl.names.map(n => handlers.filter(h => normalize(h.name) === normalize(n)));
      if (new Set(idl.names.map(normalize)).size !== idl.names.length || selected.some(h => h.length !== 1)) {
        issue(idl.file, 'IDL handlers cannot be mapped unambiguously to source', manifest);
      } else {
        program.handlers = selected.map(h => h[0]!); program.handlerSource = 'idl'; program.idl = idl.file;
      }
    } else if (matching.length > 1) issue(manifest, 'Multiple matching IDLs; retaining syntax inventory');
    result.programs.push(program);
  }
  return result;
}
