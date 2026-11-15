import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createSourceFetch, type SourceLimits } from '../src/runtime/source-fetch.ts';
import { createWeb } from '../src/runtime/web.ts';

const SHA = 'a'.repeat(40);
const scratch = () => mkdtempSync(join(tmpdir(), 'oms-source-test-'));

/** A gzip tarball of `files` under one top directory, built with the system tar like a real GitHub or npm archive. */
function tarball(top: string, files: Record<string, string>, extra?: (dir: string) => void): Buffer {
  const work = scratch();
  try {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(work, top, name, '..'), { recursive: true });
      writeFileSync(join(work, top, name), body);
    }
    extra?.(join(work, top));
    execFileSync('tar', ['-czf', join(work, 'out.tgz'), '-C', work, top]);
    return readFileSync(join(work, 'out.tgz'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** A gzip tarball with one regular entry whose name is written verbatim, which tar will not create from a directory. */
function rawTarball(name: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write('00000000000\0', 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const sum = [...header].reduce((a, b) => a + b, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
}

interface Served {
  url: string;
  auth: string | null;
}
function server(routes: Record<string, () => Response>, seen: Served[] = []) {
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: new Headers(init.headers).get('authorization') });
    const route = routes[url];
    assert.ok(route, `unexpected request to ${url}`);
    assert.equal(init.redirect, 'manual');
    return route();
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const archive = (bytes: Buffer) => new Response(new Uint8Array(bytes), { status: 200 });
const make = (routes: Record<string, () => Response>, limits?: Partial<SourceLimits>, dir = scratch()) => {
  const { fetch, seen } = server(routes);
  const hosts: string[] = [];
  const fetcher = createSourceFetch({
    dir,
    fetch,
    checkHost: async (host) => {
      hosts.push(host);
    },
    limits,
  });
  return { ...fetcher, dir, seen, hosts };
};
const repoRoutes = (bytes: Buffer, ref = 'HEAD') => ({
  [`https://api.github.com/repos/acme/prog/commits/${ref}`]: () => json({ sha: SHA }),
  [`https://codeload.github.com/acme/prog/tar.gz/${SHA}`]: () => archive(bytes),
});
const PROGRAM = { 'Cargo.toml': '[package]', 'programs/x/src/instruction.rs': 'pub enum XInstruction { Init }' };

test('a GitHub repo is resolved to a sha, extracted outside the task, and summarised with its path, sha and tree', async () => {
  const { fetchSource, dir, seen, hosts } = make(repoRoutes(tarball(`prog-${SHA}`, PROGRAM)));
  const text = await fetchSource({ repo: 'acme/prog' });
  const target = join(dir, `acme__prog@${SHA}`);
  assert.equal(readFileSync(join(target, 'programs/x/src/instruction.rs'), 'utf8'), 'pub enum XInstruction { Init }');
  assert.match(text, new RegExp(`Local path: ${target}`));
  assert.ok(text.includes(SHA));
  assert.match(text, /2 files/);
  assert.match(text, /programs\/ \(1 files\)/);
  assert.match(text, /grep -rn/);
  assert.deepEqual(readdirSync(dir), [`acme__prog@${SHA}`], 'no download or staging leftovers');
  assert.deepEqual(hosts, ['api.github.com', 'codeload.github.com']);
  assert.equal(seen[0]!.auth, null);
});

test('a ref is passed to the commits API, and a GitHub token goes to the API host only', async () => {
  const { fetch, seen } = server(repoRoutes(tarball(`prog-${SHA}`, PROGRAM), 'feature/x'));
  const fetcher = createSourceFetch({ dir: scratch(), fetch, checkHost: async () => {}, githubToken: 'ghp_secret' });
  await fetcher.fetchSource({ repo: 'acme/prog', ref: 'feature/x' });
  assert.deepEqual(
    seen.map((s) => [new URL(s.url).hostname, s.auth]),
    [
      ['api.github.com', 'Bearer ghp_secret'],
      ['codeload.github.com', null],
    ],
  );
});

test('paths keeps only the named subdirectories, in their own folder', async () => {
  const { fetchSource, dir } = make(repoRoutes(tarball(`prog-${SHA}`, { ...PROGRAM, 'docs/a.md': 'x' })));
  const text = await fetchSource({ repo: 'acme/prog', paths: ['programs/x', './programs/x/src'] });
  const [kept] = readdirSync(dir);
  assert.match(kept!, new RegExp(`^acme__prog@${SHA}\\+[0-9a-f]{8}$`));
  assert.equal(existsSync(join(dir, kept!, 'programs/x/src/instruction.rs')), true);
  assert.equal(existsSync(join(dir, kept!, 'Cargo.toml')), false);
  assert.equal(existsSync(join(dir, kept!, 'docs')), false);
  assert.match(text, /only programs\/x\./);
  await assert.rejects(fetchSource({ repo: 'acme/prog', paths: ['nope'] }), /nope is not in the archive/);
  await assert.rejects(fetchSource({ repo: 'acme/prog', paths: ['../etc'] }), /not a relative subdirectory/);
});

test('an npm package is fetched from its registry metadata under a scoped folder name', async () => {
  const tgz = 'https://registry.npmjs.org/@acme/prog/-/prog-1.2.3.tgz';
  const { fetchSource, dir } = make({
    'https://registry.npmjs.org/@acme%2Fprog/latest': () => json({ version: '1.2.3', dist: { tarball: tgz } }),
    [tgz]: () =>
      archive(
        tarball('package', {
          'dist/index.d.ts': 'export {}',
          'dist/src/generated/instructions/create.js': 'export {}',
        }),
      ),
  });
  const text = await fetchSource({ npm: '@acme/prog' });
  assert.equal(readFileSync(join(dir, 'npm__acme__prog@1.2.3', 'dist/index.d.ts'), 'utf8'), 'export {}');
  assert.match(text, /npm @acme\/prog@1\.2\.3/);
  assert.match(text, /Instruction and builder folders: dist\/src\/generated, dist\/src\/generated\/instructions\n/);
});

test('hosts outside the allowlist are refused, including through a redirect or registry metadata', async () => {
  const evil = make({
    'https://api.github.com/repos/acme/prog/commits/HEAD': () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example/commit' } }),
  });
  await assert.rejects(evil.fetchSource({ repo: 'acme/prog' }), /evil\.example is not an allowed source host/);
  const registry = make({
    'https://registry.npmjs.org/pkg/latest': () =>
      json({ version: '1.0.0', dist: { tarball: 'https://evil.example/pkg.tgz' } }),
  });
  await assert.rejects(registry.fetchSource({ npm: 'pkg' }), /evil\.example is not an allowed source host/);
  const plain = make({
    'https://api.github.com/repos/acme/prog/commits/HEAD': () =>
      new Response(null, { status: 302, headers: { location: 'http://codeload.github.com/x' } }),
  });
  await assert.rejects(plain.fetchSource({ repo: 'acme/prog' }), /not an allowed source host/);
  assert.deepEqual(
    evil.seen.map((s) => s.url),
    ['https://api.github.com/repos/acme/prog/commits/HEAD'],
  );
});

test('a host that resolves to a private address is refused', async () => {
  const { fetch } = server({});
  const fetcher = createSourceFetch({
    dir: scratch(),
    fetch,
    checkHost: async () => {
      throw new Error('source_fetch refuses private, loopback and link-local addresses');
    },
  });
  await assert.rejects(fetcher.fetchSource({ repo: 'acme/prog' }), /refuses private/);
});

test('archives over the compressed, extracted or entry caps are refused and leave nothing behind', async () => {
  const big = tarball(`prog-${SHA}`, { 'blob.bin': 'x'.repeat(200_000), ...PROGRAM });
  const noise = tarball(`prog-${SHA}`, {
    'noise.bin': [...Array(4000)].map((_, i) => ((i * 2654435761) % 4294967296).toString(36)).join(''),
  });
  for (const [limits, message, bytes] of [
    [{ compressed: 100 }, /download is larger than 100 bytes/, noise],
    [{ extracted: 50_000 }, /extracted archive is larger than 50000 bytes/, big],
    [
      { entries: 3 },
      /more than 3 entries/,
      tarball(`prog-${SHA}`, PROGRAM, (dir) => {
        for (const n of [1, 2, 3]) writeFileSync(join(dir, `f${n}`), '');
      }),
    ],
  ] as const) {
    const { fetchSource, dir } = make(repoRoutes(bytes), limits);
    await assert.rejects(fetchSource({ repo: 'acme/prog' }), message);
    assert.deepEqual(readdirSync(dir), []);
  }
});

test('symlinks are left out, a missing path lists the top level, and path traversal is refused', async () => {
  const link = make(
    repoRoutes(
      tarball(`prog-${SHA}`, PROGRAM, (dir) => {
        symlinkSync('/etc/passwd', join(dir, 'passwd'));
        symlinkSync('/etc', join(dir, 'etc[1]'));
      }),
    ),
  );
  const linked = await link.fetchSource({ repo: 'acme/prog' });
  const target = join(link.dir, `acme__prog@${SHA}`);
  assert.match(linked, /2 symlinks or hard links left out/);
  assert.equal(existsSync(join(target, 'passwd')), false);
  assert.equal(existsSync(join(target, 'etc[1]')), false);
  assert.equal(readFileSync(join(target, 'programs/x/src/instruction.rs'), 'utf8'), 'pub enum XInstruction { Init }');
  const missing = make(repoRoutes(tarball(`prog-${SHA}`, PROGRAM)));
  await assert.rejects(
    missing.fetchSource({ repo: 'acme/prog', paths: ['nope'] }),
    /nope is not in the archive; its top level is: Cargo.toml, programs\//,
  );
  assert.deepEqual(readdirSync(missing.dir), []);
  const escape = make(repoRoutes(rawTarball('prog/../../escape.txt')));
  await assert.rejects(escape.fetchSource({ repo: 'acme/prog' }), /escapes the target directory/);
  assert.deepEqual(readdirSync(escape.dir), []);
  assert.equal(existsSync(join(escape.dir, '..', 'escape.txt')), false);
});

test('the per-request budget counts distinct repositories, not repeats, and resets', async () => {
  const bytes = tarball(`prog-${SHA}`, PROGRAM);
  const routes: Record<string, () => Response> = {};
  for (const name of ['a', 'b', 'c']) {
    routes[`https://api.github.com/repos/acme/${name}/commits/HEAD`] = () => json({ sha: SHA });
    routes[`https://codeload.github.com/acme/${name}/tar.gz/${SHA}`] = () => archive(bytes);
  }
  const { fetchSource, resetBudget, seen } = make(routes, { repositories: 2 });
  await fetchSource({ repo: 'acme/a' });
  await fetchSource({ repo: 'acme/b' });
  await fetchSource({ repo: 'acme/a' });
  await assert.rejects(fetchSource({ repo: 'acme/c' }), /budget for this request is used \(2 repositories\)/);
  assert.equal(
    seen.some((s) => s.url.includes('/acme/c/')),
    false,
    'a refused repository costs no request',
  );
  resetBudget();
  await fetchSource({ repo: 'acme/c' });
});

test('bad input is refused before any request', async () => {
  const { fetchSource, seen } = make({});
  for (const request of [
    {},
    { repo: 'a/b', npm: 'x' },
    { repo: 'not-a-repo' },
    { repo: 'a/b', ref: '--upload-pack=x' },
    { repo: 'a/b', ref: 'x/../y' },
    { npm: '../x' },
    { npm: 'x', version: '1 2' },
  ]) {
    await assert.rejects(fetchSource(request), /source_fetch refused/, JSON.stringify(request));
  }
  assert.deepEqual(seen, []);
});

test('the tool is registered with the web tools, extracts into the configured folder, and turns off with them', async () => {
  const dir = scratch();
  const { fetch } = server(repoRoutes(tarball(`prog-${SHA}`, PROGRAM)));
  const web = createWeb({
    enabled: true,
    env: {},
    fetch,
    sourcesDir: dir,
    lookup: async () => [{ address: '140.82.112.3', family: 4 }],
  });
  assert.ok(web.toolNames.includes('source_fetch'));
  const tools = new Map<string, (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>>();
  const handlers: Array<() => void> = [];
  web.extension({
    on: (_event: string, handler: () => void) => handlers.push(handler),
    registerTool: (tool: { name: string; execute: never }) => tools.set(tool.name, tool.execute),
  } as never);
  const result = await tools.get('source_fetch')!('id', { repo: 'acme/prog' });
  assert.ok(existsSync(join(dir, `acme__prog@${SHA}`, 'Cargo.toml')));
  assert.match(result.content[0]!.text, /Local path/);
  web.setEnabled(false);
  await assert.rejects(tools.get('source_fetch')!('id', { repo: 'acme/prog' }), /Web access is off/);
});
