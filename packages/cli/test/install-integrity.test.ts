import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { incompleteInstallMessage } from '../src/install-integrity.ts';

function installWithMissingFile(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'oms-install-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version: '9.9.9', type: 'module' }));
  const dependency = join(root, 'node_modules', 'dep', 'dist');
  mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, 'index.js'), 'import values from "./data/models.json" with { type: "json" };\n');
  return root;
}

test('a file missing from the published package names the file and the reinstall command', async (t) => {
  const root = installWithMissingFile('@barestate/oms');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const error = await import(pathToFileURL(join(root, 'node_modules/dep/dist/index.js')).href).catch((e) => e);
  assert.equal(
    incompleteInstallMessage(error, root),
    `oms: this installation is incomplete; ${join('node_modules', 'dep', 'dist', 'data', 'models.json')} is missing.\n` +
      'Reinstall it: npm install -g @barestate/oms@9.9.9',
  );
});

test('a source checkout is told to reinstall its dependencies', async (t) => {
  const root = installWithMissingFile('oms-monorepo');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const error = await import(pathToFileURL(join(root, 'node_modules/dep/dist/index.js')).href).catch((e) => e);
  assert.match(incompleteInstallMessage(error, root) ?? '', /npm ci --ignore-scripts$/);
});

test('other errors are left to the caller', () => {
  const root = join(tmpdir(), 'oms-install-root');
  const outside = Object.assign(new Error('missing'), {
    code: 'ERR_MODULE_NOT_FOUND',
    url: pathToFileURL(join(tmpdir(), 'elsewhere', 'x.js')).href,
  });
  assert.equal(incompleteInstallMessage(outside, root), undefined);
  assert.equal(
    incompleteInstallMessage(Object.assign(new Error('bare'), { code: 'ERR_MODULE_NOT_FOUND' }), root),
    undefined,
  );
  assert.equal(incompleteInstallMessage(new Error('boom'), root), undefined);
  assert.equal(incompleteInstallMessage('text', root), undefined);
});
