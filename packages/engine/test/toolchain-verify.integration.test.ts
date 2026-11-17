import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolchainEnvironment } from '../test-support/toolchain-environment.ts';
import { verifyToolchainProject } from '../src/toolchain/verify.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';
test(
  'toolchain verifier directly reports real pinned build/test success and refuses a failing project test',
  { timeout: 1_800_000 },
  async (t) => {
    const environment = toolchainEnvironment(t);
    if (!environment) return;
    if (
      await skipUnavailable(t, {
        docker: [environment.image, environment.forwarderImage],
        surfpool: environment.binary,
      })
    )
      return;
    const root = await mkdtemp(join(tmpdir(), 'oms-toolchain-verify-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(fileURLToPath(new URL('../test-support/fixtures/anchor-counter', import.meta.url)), root, {
      recursive: true,
    });
    // Reuse the repository's already-approved Kit lock entries, adding no OMS dependency.
    const repositoryLock = JSON.parse(await readFile(new URL('../../../package-lock.json', import.meta.url), 'utf8'));
    const manifest = {
      name: 'toolchain-client-fixture',
      version: '0.1.0',
      type: 'module',
      dependencies: { '@solana/kit': '8.6.0' },
      scripts: { preinstall: 'node -e "process.exit(99)"' },
    };
    const packages: Record<string, any> = { '': manifest };
    const pending = ['node_modules/@solana/kit'];
    while (pending.length) {
      const path = pending.pop()!;
      if (packages[path]) continue;
      const record = repositoryLock.packages[path];
      assert.ok(record, `missing approved lock entry ${path}`);
      packages[path] = record;
      for (const name of Object.keys({
        ...record.dependencies,
        ...record.optionalDependencies,
        ...record.peerDependencies,
      })) {
        const nested = `${path}/node_modules/${name}`,
          hoisted = `node_modules/${name}`;
        if (repositoryLock.packages[nested]) pending.push(nested);
        else if (repositoryLock.packages[hoisted]) pending.push(hoisted);
        else
          assert.ok(
            record.peerDependenciesMeta?.[name]?.optional || record.optionalDependencies?.[name],
            `missing locked dependency ${name}`,
          );
      }
    }
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
    await writeFile(
      join(root, 'package-lock.json'),
      JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, packages }),
    );
    const clientTest = join(root, 'checks/counter.ts');
    await writeFile(
      clientTest,
      `import { createTransactionMessage } from '@solana/kit';\n` +
        (await readFile(clientTest, 'utf8')) +
        `\ntest('locked Kit client creates transaction v1',()=>{assert.equal(createTransactionMessage({version:1}).version,1);});\n`,
    );
    const passed = await verifyToolchainProject(root, environment.binary);
    assert.deepEqual(passed, {
      status: 'build and tests passed',
      image: environment.image,
      buildExitCode: 0,
      testExitCode: 0,
    });
    const path = join(root, 'Anchor.toml');
    await writeFile(
      path,
      (await readFile(path, 'utf8')).replace('node --test checks/counter.ts', "node -e 'process.exit(1)'"),
    );
    const failed = await verifyToolchainProject(root, environment.binary);
    assert.equal(failed.status, 'proposed, not verified');
    assert.equal(failed.buildExitCode, 0, 'negative case must pass build and fail its test');
    assert.notEqual(failed.testExitCode, 0);
  },
);
