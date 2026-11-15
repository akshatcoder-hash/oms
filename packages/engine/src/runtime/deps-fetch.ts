/** Runs inside the install sandbox, before either package manager can read project configuration. */
export async function validateDependencyProject(root: string, manager: 'cargo' | 'npm'): Promise<void> {
  const { lstat, readFile, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  async function text(path: string): Promise<string> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
      throw new Error('E_DEPS_POLICY: unsafe dependency file');
    return readFile(path, 'utf8');
  }
  if (manager === 'npm') {
    const lock = JSON.parse(await text(join(root, 'package-lock.json')));
    const manifest = JSON.parse(await text(join(root, 'package.json')));
    for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const spec of Object.values(manifest[kind] ?? {})) {
        if (
          typeof spec !== 'string' ||
          /^(?:git\+|git:|github:|gitlab:|bitbucket:)|\.git(?:#|$)|^[^/@\s]+\/[^/\s]+(?:#.*)?$/i.test(spec)
        ) {
          throw new Error('E_DEPS_POLICY: npm git dependencies refused');
        }
      }
    }
    if (![2, 3].includes(lock.lockfileVersion) || !lock.packages)
      throw new Error('E_DEPS_POLICY: npm lockfile v2 or v3 required');
    for (const [path, value] of Object.entries(lock.packages)) {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('E_DEPS_POLICY: invalid npm package record');
      const pkg = value as { resolved?: unknown; link?: unknown };
      if (
        pkg.link ||
        (path !== '' && (typeof pkg.resolved !== 'string' || !pkg.resolved.startsWith('https://registry.npmjs.org/')))
      ) {
        throw new Error('E_DEPS_POLICY: only npm registry dependencies are supported');
      }
    }
    return;
  }
  const { execFileSync } = await import('node:child_process');
  function toml(contents: string): unknown {
    try {
      return JSON.parse(
        execFileSync(
          'python3',
          ['-I', '-c', 'import tomllib,json,sys; print(json.dumps(tomllib.loads(sys.stdin.read())))'],
          {
            cwd: root,
            input: contents,
            encoding: 'utf8',
            timeout: 5000,
            maxBuffer: 16 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        ),
      );
    } catch {
      throw new Error('E_DEPS_POLICY: invalid Cargo TOML');
    }
  }
  const lock = toml(await text(join(root, 'Cargo.lock'))) as { package?: Array<{ source?: string }> };
  for (const pkg of lock.package ?? []) {
    if (pkg.source && pkg.source !== 'registry+https://github.com/rust-lang/crates.io-index') {
      throw new Error('E_DEPS_POLICY: non-crates.io dependency refused');
    }
  }
  function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }
  function check(value: unknown, configuration: boolean): void {
    const table = record(value);
    if (['source', 'patch', 'registries', ...(configuration ? ['net', 'env'] : [])].some((key) => key in table)) {
      throw new Error('E_DEPS_POLICY: Cargo source, patch, registry and network overrides refused');
    }
    if (configuration) {
      const build = record(table.build);
      if (['rustc-wrapper', 'rustc-workspace-wrapper', 'rustc'].some((key) => key in build)) {
        throw new Error('E_DEPS_POLICY: Cargo compiler overrides refused');
      }
      return;
    }
    const scopes = [table, record(table.workspace), ...Object.values(record(table.target)).map(record)];
    for (const scope of scopes)
      for (const kind of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
        for (const dependency of Object.values(record(scope[kind]))) {
          const spec = record(dependency);
          if ('git' in spec || 'registry' in spec)
            throw new Error('E_DEPS_POLICY: git and alternate registry dependencies refused');
        }
      }
  }
  async function walk(dir: string): Promise<void> {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (['target', 'node_modules', '.git', '.oms-cargo'].includes(item.name)) continue;
      const path = join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error('E_DEPS_POLICY: symlinks refused during dependency fetch');
      if (item.isDirectory()) await walk(path);
      else if (
        item.name === 'Cargo.toml' ||
        (dir.endsWith('/.cargo') && ['config', 'config.toml'].includes(item.name))
      ) {
        check(toml(await text(path)), item.name !== 'Cargo.toml');
      }
    }
  }
  await text(join(root, 'Cargo.toml'));
  await walk(root);
  for (const name of ['config', 'config.toml']) {
    try {
      await text(join(root, '.oms-cargo', name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error('E_DEPS_POLICY: CARGO_HOME configuration refused');
  }
}

export function dependencyFetchArgv(manager: 'cargo' | 'npm'): string[] {
  return [
    'node',
    '--input-type=module',
    '-e',
    `
    const validate = (${validateDependencyProject.toString()});
    await validate('/work', ${JSON.stringify(manager)});
    const { spawn } = await import('node:child_process');
    const child = spawn(${JSON.stringify(manager)}, ${JSON.stringify(manager === 'cargo' ? ['fetch', '--locked'] : ['ci', '--ignore-scripts', '--registry=https://registry.npmjs.org/'])}, { stdio: 'inherit' });
    child.on('error', () => { process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  `,
  ];
}

export const DEPENDENCY_ALLOWLIST = ['index.crates.io:443', 'static.crates.io:443', 'registry.npmjs.org:443'];
