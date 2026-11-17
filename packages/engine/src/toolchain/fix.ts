import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkToolchain } from './check.ts';
import type { ProjectSnapshot } from './project.ts';
import { PINNED, RULES } from './rules.ts';
import { toolchainBuildCommand } from './build.ts';
export interface FileEdit {
  path: string;
  before: string | null;
  after: string;
}
export interface FixPlan {
  status: 'proposed, not verified';
  edits: FileEdit[];
  commands: string[][];
  manual: string[];
}
/** Resolve ordinary dotted/quoted TOML table names against the already parsed manifest.
 * Unsupported escape forms are left for manual review rather than guessed edits. */
function tablePath(section: string): string[] | undefined {
  const token = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(\.|$)/gy;
  let offset = 0;
  const keys: string[] = [];
  while (offset < section.length) {
    token.lastIndex = offset;
    const match = token.exec(section);
    if (!match) return undefined;
    let key = match[1]!;
    if (key.startsWith('"')) {
      try {
        key = JSON.parse(key);
      } catch {
        return undefined;
      }
    } else if (key.startsWith("'")) key = key.slice(1, -1);
    keys.push(key);
    offset = token.lastIndex;
  }
  return keys;
}
function dependencyTable(data: Record<string, any> | undefined, keys: string[]): Record<string, any> | undefined {
  return keys.reduce((table, key) => table?.[key], data);
}
/** Exact dependency/import proposals accompany mechanical edits; builds/tests must verify API migrations. */
export function planToolchainFix(project: ProjectSnapshot): FixPlan {
  const report = checkToolchain(project);
  const edits: FileEdit[] = [];
  const manual = new Set<string>();
  const migratingAnchor = report.findings.some((f) => f.rule === 'anchor' || f.rule === 'advisory');
  const migratingClient = migratingAnchor || report.findings.some((f) => f.rule === 'client');
  const repairArch =
    report.findings.some((f) => f.rule === 'arch') && toolchainBuildCommand(project, 'cargo').includes('v3');
  const repairScriptArch = (script: string) =>
    repairArch ? script.replace(/(--arch(?:=|\s+))v[0-4]\b/g, `$1${PINNED.arch}`) : script;
  for (const file of project.files) {
    let after = file.text;
    if (file.path.endsWith('Anchor.toml')) {
      let section = '';
      after = after
        .split(/(?<=\n)/)
        .map((line) => {
          const header = /^\s*\[([^\]]+)\]/.exec(line);
          if (header) section = header[1]!;
          const keys = tablePath(section);
          if (keys?.length === 1 && keys[0] === 'scripts') line = repairScriptArch(line);
          if (keys?.length === 1 && keys[0] === 'toolchain') {
            if (
              /^\s*(?:solana_version|"solana_version"|'solana_version')\s*=\s*["'][^"'\n]+["']\s*(?:#[^\n]*)?\r?\n?$/.test(
                line,
              )
            )
              return '';
            line = line.replace(
              /^(\s*(?:anchor_version|"anchor_version"|'anchor_version')\s*=\s*)["'][^"']+["']/,
              `$1"${PINNED.anchor}"`,
            );
            line = line.replace(
              /^(\s*(?:package_manager|"package_manager"|'package_manager')\s*=\s*)["'][^"']+["']/,
              `$1"${PINNED.packageManager}"`,
            );
          }
          // Build wrappers own platform-tools; they reject attempts to switch versions.
          return line.replace(/\s+--tools-version(?:=|\s+)v?\d+\.\d+\b/g, '');
        })
        .join('');
    }
    if (file.path.endsWith('Cargo.toml') && migratingAnchor) {
      let section = '';
      after = after
        .split(/(?<=\n)/)
        .map((line) => {
          const header = /^\s*\[([^\]]+)\]/.exec(line);
          if (header) section = header[1]!;
          const keys = tablePath(section);
          if (!keys) return line;
          const dependencyKinds = ['dependencies', 'dev-dependencies', 'build-dependencies'];
          // Cargo accepts both inline entries and [dependencies.name] tables.
          if (dependencyKinds.includes(keys.at(-2) ?? '')) {
            const dep = dependencyTable(file.data, keys);
            const name = keys.at(-1);
            if (
              name !== 'anchor-lang' &&
              name !== 'anchor-spl' &&
              dep?.package !== 'anchor-lang' &&
              dep?.package !== 'anchor-spl'
            )
              return line;
            if (!dep || dep.git || dep.path || dep.workspace) return line;
            return line.replace(/^(\s*version\s*=\s*)["'][^"']+["']/, `$1"=${PINNED.anchor}"`);
          }
          if (!dependencyKinds.includes(keys.at(-1) ?? '')) return line;
          const entry = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+)\s*=\s*/.exec(line);
          const name = entry && tablePath(entry[1]!)?.[0];
          if (!entry || !name) return line;
          const dep = dependencyTable(file.data, keys)?.[name];
          if (
            name !== 'anchor-lang' &&
            name !== 'anchor-spl' &&
            dep?.package !== 'anchor-lang' &&
            dep?.package !== 'anchor-spl'
          )
            return line;
          if (typeof dep === 'object' && (dep.git || dep.path || dep.workspace)) return line;
          if (typeof dep === 'string')
            return entry[0] + line.slice(entry[0].length).replace(/^["'][^"']+["']/, `"=${PINNED.anchor}"`);
          return line.replace(/(version\s*=\s*)["'][^"']+["']/, `$1"=${PINNED.anchor}"`);
        })
        .join('');
    }
    if (file.path.endsWith('package.json')) {
      const data = structuredClone(file.data);
      if (!data) continue;
      let changed = false;
      for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        const deps = data?.[kind];
        if (!deps) continue;
        if (migratingClient && deps[RULES.client.legacyPackage]) {
          delete deps[RULES.client.legacyPackage];
          deps[RULES.client.package] = PINNED.anchor;
          changed = true;
        }
        if (report.findings.some((f) => f.rule === 'transaction' && f.path === file.path)) {
          if (deps['@solana/web3.js']) deps['@solana/web3.js'] = RULES.transaction.recommendedWeb3;
          if (deps['@solana/kit']) deps['@solana/kit'] = RULES.transaction.minimumKit;
          changed = true;
        }
      }
      if (
        report.findings.some((f) => f.rule === 'pins' && f.path === file.path && f.message.startsWith('Build script'))
      ) {
        for (const [name, script] of Object.entries(data?.scripts ?? {}))
          if (typeof script === 'string')
            data.scripts[name] = script.replace(/\s+--tools-version(?:=|\s+)v?\d+\.\d+\b/g, '');
        changed = true;
      }
      for (const [name, script] of Object.entries(data.scripts ?? {}))
        if (typeof script === 'string') {
          const repaired = repairScriptArch(script);
          if (repaired !== script) {
            data.scripts[name] = repaired;
            changed = true;
          }
        }
      if (changed) after = JSON.stringify(data, null, 2) + '\n';
    }
    if (migratingClient && /\.(ts|tsx|js|mjs)$/.test(file.path))
      after = after
        .replaceAll('@coral-xyz/anchor/dist/cjs/idl', '@anchor-lang/core')
        .replaceAll('@coral-xyz/anchor', '@anchor-lang/core');
    if (after !== file.text) edits.push({ path: file.path, before: file.text, after });
  }
  for (const finding of report.findings) {
    if (
      finding.rule === 'pins' &&
      finding.message.startsWith('solana_version') &&
      edits.some((e) => e.path === finding.path)
    )
      continue;
    if (
      finding.rule === 'anchor' ||
      finding.rule === 'advisory' ||
      finding.rule === 'client' ||
      finding.rule === 'transaction'
    )
      manual.add(
        `${finding.path}: proposed version/import edits need API migration review and real build/tests; lockfiles must be regenerated in the pinned image.`,
      );
    else if (!edits.some((e) => e.path === finding.path)) manual.add(`${finding.path}: ${finding.remedy}`);
  }
  const commands: string[][] = [];
  if (project.files.some((f) => f.path.endsWith('Cargo.toml')))
    commands.push(['cargo', 'tree', '-d'], ['cargo', 'generate-lockfile'], toolchainBuildCommand(project, 'cargo'), [
      'cargo',
      'test',
      '--locked',
      '--offline',
    ]);
  if (project.files.some((f) => f.path === 'Anchor.toml'))
    commands.push(toolchainBuildCommand(project, 'anchor'), [
      'anchor',
      'test',
      '--skip-build',
      '--skip-deploy',
      '--skip-local-validator',
    ]);
  if (project.files.some((f) => f.path === 'package.json'))
    commands.push(
      ['npm', 'install', '--package-lock-only', '--ignore-scripts'],
      ['npm', 'ci', '--ignore-scripts'],
      ['npm', 'test'],
    );
  return { status: 'proposed, not verified', edits, commands, manual: [...manual] };
}
/** --apply is restricted to the selected linked Git task worktree, never the main checkout. */
export function applyToolchainFix(project: ProjectSnapshot, plan: FixPlan): void {
  const root = realpathSync(project.root);
  const gitPath = join(root, '.git');
  if (!lstatSync(gitPath).isFile() || lstatSync(gitPath).isSymbolicLink())
    throw new Error('--apply requires a linked task worktree (.git file)');
  const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (realpathSync(top) !== root) throw new Error('--apply requires the task worktree root');
  // Validate all paths and preimages before writing anything. Refuse traversals and symlink parents.
  for (const edit of plan.edits) {
    const path = resolve(root, edit.path);
    if (
      !edit.path ||
      relative(root, path).startsWith('..' + sep) ||
      relative(root, path) === '..' ||
      path === root ||
      edit.path.startsWith('.git')
    )
      throw new Error('unsafe edit path');
    let parent = dirname(path);
    while (parent !== root) {
      if (lstatSync(parent).isSymbolicLink()) throw new Error('symlink edit parent');
      parent = dirname(parent);
    }
    let actual: string | null = null;
    try {
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('unsafe edit target');
      actual = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (actual !== edit.before) throw new Error(`stale fix plan: ${edit.path}`);
  }
  for (const edit of plan.edits)
    writeFileSync(join(root, edit.path), edit.after, { flag: edit.before === null ? 'wx' : 'w' });
}
