import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installSurfpool } from '../src/doctor/install.ts';

const dir = mkdtempSync(join(tmpdir(), 'oms-install-test-'));
mkdirSync(join(dir, 'pack'));
writeFileSync(join(dir, 'pack', 'surfpool'), '#!/bin/sh\necho surfpool 1.7.0\n');
execFileSync('tar', ['-czf', join(dir, 'surfpool.tar.gz'), '-C', join(dir, 'pack'), 'surfpool']);
const archive = readFileSync(join(dir, 'surfpool.tar.gz'));
const sha256 = createHash('sha256').update(archive).digest('hex');

async function withServer(run: (url: string) => Promise<void>) {
  const server = createServer((request, response) => {
    if (request.url === '/surfpool.tar.gz') {
      response.end(archive);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test('installs the executable when the SHA-256 matches', async () => {
  await withServer(async (base) => {
    const target = join(dir, 'good', 'tools', 'surfpool');
    await installSurfpool({ url: `${base}/surfpool.tar.gz`, sha256 }, target);
    assert.equal(readFileSync(target, 'utf8').includes('surfpool 1.7.0'), true);
    assert.ok(statSync(target).mode & 0o100);
  });
});

test('refuses a wrong checksum and installs nothing', async () => {
  await withServer(async (base) => {
    const target = join(dir, 'bad', 'surfpool');
    await assert.rejects(
      installSurfpool({ url: `${base}/surfpool.tar.gz`, sha256: '0'.repeat(64) }, target),
      /SHA-256 mismatch/,
    );
    assert.equal(existsSync(target), false);
  });
});

test('reports a failed download', async () => {
  await withServer(async (base) => {
    await assert.rejects(
      installSurfpool({ url: `${base}/missing`, sha256 }, join(dir, 'x', 'surfpool')),
      /Could not download .*HTTP 404/,
    );
  });
});
