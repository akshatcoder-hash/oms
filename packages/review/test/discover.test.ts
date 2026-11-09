import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverPrograms } from '../src/discover.ts';
import type { StaticExecutionPort, StaticRequest } from '../src/static/run.ts';
import type { ReviewSnapshot } from '../src/snapshot.ts';
const id = '11111111111111111111111111111111';
function setup(files: Record<string, string>, values: Record<string, unknown>) {
  const requests: StaticRequest[] = [];
  const snapshot: ReviewSnapshot = { excludedFiles: 0,
    inventory: () => new Map(Object.entries(files).map(([p, text]) => [p, text.split('\n').length])),
    read: p => files[p]!, grep: () => [] };
  const port: StaticExecutionPort = { async run(request) {
    requests.push(request);
    return { exitCode: 0, stdout: JSON.stringify(values[request.argv[2]!] ?? {}), timedOut: false, truncated: false };
  } };
  return { snapshot, port, requests };
}
const metadata = (framework = 'anchor') => ({ name: 'vault', framework, libPath: 'src/lib.rs' });
const handler = (name = 'withdraw', file = 'src/lib.rs', line = 2) => ({ name, file, line });
const basic = () => setup({ 'Cargo.toml': '', 'src/lib.rs': 'id\nfn\nhelper', 'idl/vault.json': JSON.stringify({ address: id, instructions: [{ name: 'withdraw' }] }) },
  { 'Cargo.toml': metadata(), 'src/lib.rs': { programIds: [id], handlers: [handler(), handler('helper', 'src/lib.rs', 3)] } });

test('discovery prefers a matching IDL, with validated source locations and offline captured inputs', async () => {
  const { snapshot, port, requests } = basic();
  assert.deepEqual(await discoverPrograms(snapshot, port), { programs: [{ name: 'vault', programId: id,
    framework: 'anchor', manifest: 'Cargo.toml', sources: ['src/lib.rs'], handlers: [handler()], handlerSource: 'idl', idl: 'idl/vault.json' }], issues: [] });
  for (const r of requests) {
    assert.equal(r.network, 'none'); assert.equal(r.readOnly, true);
    assert.deepEqual([...r.files.keys()], [r.argv[2]]);
    assert.ok(r.timeoutMs > 0 && r.timeoutMs <= 300000);
  }
});

test('native and Pinocchio fallback keeps helper candidates and isolates nested crates', async () => {
  for (const framework of ['native', 'pinocchio']) {
    const { snapshot, port } = setup({ 'Cargo.toml': '', 'src/lib.rs': 'id\nfn',
      'src/nested/Cargo.toml': '', 'src/nested/src/lib.rs': 'id\nfn', 'tests/test.rs': 'fn' }, {
      'Cargo.toml': metadata(framework), 'src/lib.rs': { programIds: [id], handlers: [handler()] },
      'src/nested/Cargo.toml': { name: null, framework: null, libPath: 'src/lib.rs' },
    });
    const result = await discoverPrograms(snapshot, port);
    assert.deepEqual(result, { programs: [{ name: 'vault', programId: id, framework,
      manifest: 'Cargo.toml', sources: ['src/lib.rs'], handlers: [handler()], handlerSource: 'syntax' }], issues: [] });
  }
});

test('ambiguous and malformed IDLs retain syntax candidates and record the limitation', async () => {
  for (const instructions of [[{ name: 'missing' }], [{ name: 'withdraw' }, { name: 'with_draw' }], [{ name: 5 }]]) {
    const { snapshot, port } = setup({ 'Cargo.toml': '', 'src/lib.rs': '\n\n', 'idl.json': JSON.stringify({ address: id, instructions }) },
      { 'Cargo.toml': metadata(), 'src/lib.rs': { programIds: [id], handlers: [handler()] } });
    const result = await discoverPrograms(snapshot, port);
    assert.equal(result.programs[0]?.handlerSource, 'syntax'); assert.equal(result.issues.length, 1);
  }
});

test('invalid source metadata never becomes trusted discovery', async () => {
  for (const source of [{ programIds: ['bad'], handlers: [] }, { programIds: [id], handlers: [handler('x', '../outside')] },
    { programIds: [id], handlers: [handler('x', 'src/lib.rs', 99)] }, { programIds: [id], handlers: [], extra: true }]) {
    const { snapshot, port } = setup({ 'Cargo.toml': '', 'src/lib.rs': '\n' }, { 'Cargo.toml': metadata(), 'src/lib.rs': source });
    const result = await discoverPrograms(snapshot, port);
    assert.equal(result.programs.length, 0); assert.ok(result.issues.length);
  }
});

test('traversing library paths and unsupported frameworks do not dispatch Rust parsing', async () => {
  for (const meta of [{ ...metadata(), libPath: '../escape.rs' }, { ...metadata(), framework: null }, { ...metadata(), surprise: true }]) {
    const { snapshot, port, requests } = setup({ 'Cargo.toml': '', 'src/lib.rs': '' }, { 'Cargo.toml': meta });
    const result = await discoverPrograms(snapshot, port);
    assert.equal(result.programs.length, 0); assert.equal(requests.length, 1); assert.equal(result.issues.length, 1);
  }
});

test('deadline and failed inventory are visible without raw port diagnostics', async () => {
  const { snapshot, requests } = basic();
  let tick = 0;
  const budget = await discoverPrograms(snapshot, { async run() { throw Error('secret'); } }, () => tick++ * 300001);
  assert.equal(budget.programs.length, 0); assert.equal(requests.length, 0);
  const result = await discoverPrograms(snapshot, { async run() { throw Error('secret'); } });
  assert.ok(!JSON.stringify(result).includes('secret')); assert.equal(result.issues.length, 1);
});

test('snapshot bytes are captured before the first dispatch', async () => {
  const files = { 'Cargo.toml': 'original', 'src/lib.rs': 'original\nfn' };
  const { snapshot } = setup(files, {});
  const result = await discoverPrograms(snapshot, { async run(r) {
    const file = r.argv[2]!;
    files['src/lib.rs'] = 'changed';
    assert.equal(r.files.get(file), file === 'Cargo.toml' ? 'original' : 'original\nfn');
    return { exitCode: 0, stdout: JSON.stringify(file === 'Cargo.toml' ? metadata() : { programIds: [id], handlers: [handler()] }), timedOut: false, truncated: false };
  } });
  assert.equal(result.programs.length, 1);
});

test('a crate-root library still excludes build scripts, tests and examples', async () => {
  const { snapshot, port, requests } = setup({ 'Cargo.toml': '', 'lib.rs': 'id\nfn', 'build.rs': '', 'tests/a.rs': '', 'examples/b.rs': '' },
    { 'Cargo.toml': { ...metadata('native'), libPath: 'lib.rs' }, 'lib.rs': { programIds: [id], handlers: [handler('run', 'lib.rs')] } });
  const result = await discoverPrograms(snapshot, port);
  assert.deepEqual(result.programs[0]?.sources, ['lib.rs']);
  assert.deepEqual(requests.map(r => r.argv[2]), ['Cargo.toml', 'lib.rs']);
});

test('failed submodules preserve target identity but never select IDL as complete inventory', async () => {
  const { snapshot, port } = setup({ 'Cargo.toml': '', 'src/lib.rs': 'id\nfn', 'src/bad.rs': '',
    'idl.json': JSON.stringify({ address: id, instructions: [{ name: 'withdraw' }] }) },
    { 'Cargo.toml': metadata(), 'src/lib.rs': { programIds: [id], handlers: [handler()] } });
  const result = await discoverPrograms(snapshot, port);
  assert.equal(result.programs[0]?.handlerSource, 'syntax');
  assert.deepEqual(result.issues, [{ file: 'src/bad.rs', reason: 'Rust inventory unavailable', manifest: 'Cargo.toml' }]);
});

test('account context locations must belong to the same captured handler source', async () => {
  for (const accountStruct of [
    { file: 'src/lib.rs', line: 2, endLine: 3 },
    { file: '../outside', line: 2, endLine: 3 },
    { file: 'src/lib.rs', line: 3, endLine: 2 },
    { file: 'src/lib.rs', line: 1, endLine: 99 },
  ]) {
    const { snapshot, port } = setup({ 'Cargo.toml': '', 'src/lib.rs': 'one\ntwo\nthree' }, {
      'Cargo.toml': metadata(), 'src/lib.rs': { programIds: [id], handlers: [{ ...handler(), accountStruct }] },
    });
    const result = await discoverPrograms(snapshot, port);
    if (accountStruct.file === 'src/lib.rs' && accountStruct.line === 2) {
      assert.deepEqual(result.programs[0]?.handlers[0]?.accountStruct, accountStruct);
      assert.deepEqual(result.issues, []);
    } else assert.ok(result.issues.some(i => i.reason === 'Rust inventory unavailable'));
  }
});
