import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateDependencyProject, dependencyFetchArgv } from '../src/runtime/deps-fetch.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'oms-deps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'Cargo.toml'), '[package]\nname="fixture"\nversion="0.1.0"\n');
  await writeFile(join(root, 'Cargo.lock'), 'version = 4\n');
  return root;
}

test('Cargo fetch requires lockfile and rejects git and patch sources', async (t) => {
  const root = await fixture(t);
  await validateDependencyProject(root, 'cargo');
  await writeFile(join(root, 'Cargo.toml'), '[patch.crates-io]\nfoo={path="bar"}');
  await assert.rejects(validateDependencyProject(root, 'cargo'), /E_DEPS_POLICY/);
  await writeFile(join(root, 'Cargo.toml'), '[dependencies]\nfoo={git="https:\/\/example.invalid"}');
  await assert.rejects(validateDependencyProject(root, 'cargo'), /E_DEPS_POLICY/);
  await rm(join(root, 'Cargo.lock'));
  await assert.rejects(validateDependencyProject(root, 'cargo'), /ENOENT/);
});

test('Cargo rejects nested configuration overrides and cached home configuration', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, '.cargo'));
  for (const content of [
    '[source.crates-io]',
    '[net]\noffline=false',
    '[build]\nrustc-wrapper="evil"',
    '[registries.foo]',
  ]) {
    await writeFile(join(root, '.cargo/config.toml'), content);
    await assert.rejects(validateDependencyProject(root, 'cargo'), /E_DEPS_POLICY/);
  }
  await rm(join(root, '.cargo/config.toml'));
  await mkdir(join(root, '.oms-cargo'));
  await writeFile(join(root, '.oms-cargo/config'), '');
  await assert.rejects(validateDependencyProject(root, 'cargo'), /CARGO_HOME/);
});

test('npm requires a lockfile and refuses remote git, alternate registry and links', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'package.json'), '{}');
  await assert.rejects(validateDependencyProject(root, 'npm'), /ENOENT/);
  for (const pkg of [
    { resolved: 'git+https://example.invalid/a' },
    { resolved: 'https://example.invalid/a.tgz' },
    { link: true },
  ]) {
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { a: pkg } }));
    await assert.rejects(validateDependencyProject(root, 'npm'), /E_DEPS_POLICY/);
  }
  await writeFile(
    join(root, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, packages: { a: { resolved: 'https://registry.npmjs.org/a/-/a-1.tgz' } } }),
  );
  await validateDependencyProject(root, 'npm');
  assert.ok(dependencyFetchArgv('npm').join(' ').includes('--ignore-scripts'));
});

test('Cargo parser ignores project Python modules and rejects escaped override keys', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'tomllib.py'), 'raise RuntimeError("project module executed")');
  await writeFile(join(root, 'json.py'), 'raise RuntimeError("project module executed")');
  await validateDependencyProject(root, 'cargo');
  await writeFile(join(root, 'Cargo.toml'), '["patch".crates-io]\nfoo={path="bar"}');
  await assert.rejects(validateDependencyProject(root, 'cargo'), /E_DEPS_POLICY/);
});

test('Cargo policy permits metadata and dependency aliases with reserved-looking names', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'Cargo.toml'),
    '[package.metadata]\nsource="documentation"\n[dependencies]\nnet="1.0"\nsource={version="1.0"}',
  );
  await validateDependencyProject(root, 'cargo');
});

test('npm accepts repository metadata but refuses git dependency specifications', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ repository: 'github:org/project' }));
  await validateDependencyProject(root, 'npm');
  for (const spec of [
    'github:org/project',
    'org/project',
    'git+https://example.invalid/pkg.git',
    'https://example.invalid/pkg.git',
  ]) {
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { pkg: spec } }));
    await assert.rejects(validateDependencyProject(root, 'npm'), /E_DEPS_POLICY/);
  }
});
