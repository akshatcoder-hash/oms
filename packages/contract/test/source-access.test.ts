import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireSourceAccess, withSourceAccess } from '../src/source-access.ts';
import { saveCodeInputs, digestCodeInputs, EMPTY_SNAPSHOT_DIGEST } from '../src/inputs.ts';
import { makeProject } from '../test-support/fixture.ts';

test('source ownership excludes live and crashed foreign processes until explicit host recovery', (t) => {
  const p = makeProject();
  t.after(() => p.cleanup());
  const sourceControlDir = join(p.outside, 'source-control');
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { acquireSourceAccess } from ${JSON.stringify(new URL('../src/source-access.ts', import.meta.url).href)};
    acquireSourceAccess(${JSON.stringify(p.root)}, { sourceControlDir: ${JSON.stringify(sourceControlDir)}, kind: 'sandbox' });
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.throws(() => saveCodeInputs(p.root, p.config, { sourceControlDir }), { code: 'E_SOURCE_BUSY' });
  assert.equal(readdirSync(sourceControlDir).length, 1, 'dead process ownership must not be guessed away');
});

test('synchronous capture is nested but never reenters an active sandbox ownership', (t) => {
  const p = makeProject();
  t.after(() => p.cleanup());
  const options = { sourceControlDir: join(p.outside, 'source-control') };
  const release = acquireSourceAccess(p.root, { ...options, kind: 'sandbox' });
  assert.throws(() => digestCodeInputs(p.root, p.config, options), { code: 'E_SOURCE_BUSY' });
  release();
  release();
  withSourceAccess(
    p.root,
    () => {
      const saved = saveCodeInputs(p.root, p.config, options);
      try {
        assert.equal(saved.codeDigest, digestCodeInputs(p.root, p.config, options));
      } finally {
        saved.dispose();
      }
    },
    options,
  );
});
test('source ownership covers overlapping roots, including a different sandbox project ancestor', (t) => {
  const p = makeProject();
  t.after(() => p.cleanup());
  const options = { sourceControlDir: join(p.outside, 'source-control') };
  const release = acquireSourceAccess(p.root, { ...options, kind: 'sandbox' });
  try {
    assert.throws(() => acquireSourceAccess(join(p.root, 'src'), { ...options, kind: 'sandbox' }), {
      code: 'E_SOURCE_BUSY',
    });
    assert.throws(() => acquireSourceAccess(p.roots.workspaceRoot, { ...options, kind: 'sandbox' }), {
      code: 'E_SOURCE_BUSY',
    });
  } finally {
    release();
  }
  const child = acquireSourceAccess(join(p.root, 'src'), { ...options, kind: 'sandbox' });
  try {
    assert.throws(() => digestCodeInputs(p.root, p.config, options), { code: 'E_SOURCE_BUSY' });
  } finally {
    child();
  }
});

for (const substitution of ['symlink', 'fifo', 'directory'] as const) {
  test(`lstat-to-open ${substitution} substitution refuses capture before consuming substituted bytes`, (t) => {
    const p = makeProject();
    t.after(() => p.cleanup());
    const target = join(p.root, 'race.txt');
    const secret = join(p.outside, 'secret');
    writeFileSync(target, 'original');
    writeFileSync(secret, 'outside sentinel');
    const original = fs.lstatSync;
    let replaced = false;
    const originalReadFile = fs.readFileSync;
    const originalRead = fs.readSync;
    const secretInfo = fs.statSync(secret);
    let outsideReads = 0;
    let unsafePathReads = 0;
    const readFile = t.mock.method(fs, 'readFileSync', (file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (typeof file === 'string' && fs.realpathSync(file) === secret) outsideReads++;
      if (file === target) {
        unsafePathReads++;
        throw new Error('pathname capture read rejected by regression probe');
      }
      return Reflect.apply(originalReadFile, fs, [file, ...args]);
    });
    const read = t.mock.method(fs, 'readSync', (fd: number, ...args: unknown[]) => {
      const opened = fs.fstatSync(fd);
      if (opened.dev === secretInfo.dev && opened.ino === secretInfo.ino) outsideReads++;
      return Reflect.apply(originalRead, fs, [fd, ...args]);
    });
    const mock = t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
      const info = original(...args);
      if (!replaced && args[0] === target) {
        replaced = true;
        fs.unlinkSync(target);
        if (substitution === 'symlink') fs.symlinkSync(secret, target);
        else if (substitution === 'directory') mkdirSync(target);
        else {
          const result = spawnSync('mkfifo', [target]);
          assert.equal(result.status, 0);
        }
      }
      return info;
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => saveCodeInputs(p.root, p.config));
      assert.equal(replaced, true);
      assert.equal(outsideReads, 0, 'substituted outside bytes must never be consumed, even by a failed capture');
      assert.equal(unsafePathReads, 0, 'capture must use checked bounded descriptor reads, never a pathname read');
    } finally {
      mock.mock.restore();
      readFile.mock.restore();
      read.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

test('source control must remain private and outside the source tree', (t) => {
  const p = makeProject();
  t.after(() => p.cleanup());
  assert.throws(() => acquireSourceAccess(p.root, { kind: 'capture', sourceControlDir: join(p.root, 'locks') }), {
    code: 'E_SOURCE_CONTROL',
  });
  const publicControl = join(p.outside, 'public');
  mkdirSync(publicControl, { mode: 0o755 });
  assert.throws(() => acquireSourceAccess(p.root, { kind: 'capture', sourceControlDir: publicControl }), {
    code: 'E_SOURCE_CONTROL',
  });
});

test('a substituted directory ancestor is rejected before traversal reads any source file', (t) => {
  const p = makeProject();
  t.after(() => p.cleanup());
  const target = join(p.root, 'src');
  const original = fs.lstatSync;
  let replaced = false;
  const mock = t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
    const info = original(...args);
    if (!replaced && args[0] === target) {
      replaced = true;
      fs.renameSync(target, `${target}-original`);
      fs.symlinkSync(p.outside, target);
    }
    return info;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => saveCodeInputs(p.root, p.config));
    assert.equal(replaced, true);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const substitution of ['root', 'ancestor'] as const) {
  test(`an admitted ${substitution} cannot be reauthorized to an outside symlink target before capture`, (t) => {
    const p = makeProject();
    t.after(() => p.cleanup());
    const parent = join(p.root, 'admitted-parent');
    const child = join(parent, 'child');
    const outsideParent = join(p.outside, 'outside-tree');
    const outside = substitution === 'root' ? outsideParent : join(outsideParent, 'child');
    mkdirSync(child, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(child, 'package.json'), '{}');
    writeFileSync(join(outside, 'package.json'), '{}');
    writeFileSync(join(outside, 'outside-marker'), 'outside synthetic bytes');
    const config = {
      schema: 'oms.evaluator/0' as const,
      codePaths: ['package.json'],
      snapshotDigest: EMPTY_SNAPSHOT_DIGEST,
      executionIdentity: 'test:admitted-root',
    };
    const options = { sourceControlDir: p.roots.sourceControlDir };
    const release = acquireSourceAccess(parent, { ...options, kind: 'sandbox' });
    try {
      const replaced = substitution === 'root' ? child : parent;
      fs.renameSync(replaced, `${replaced}-original`);
      fs.symlinkSync(outsideParent, replaced);
      assert.throws(() => saveCodeInputs(child, config, options));
      assert.throws(() => acquireSourceAccess(child, { ...options, kind: 'sandbox' }));
    } finally {
      release();
    }
    assert.throws(
      () => saveCodeInputs(child, config, options),
      'release must not authorize the substituted destination either',
    );
  });
}
