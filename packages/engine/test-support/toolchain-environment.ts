import type { TestContext } from 'node:test';
import { join } from 'node:path';
import { configuredToolchainImage, defaultHarnessEnvironment } from '../src/runtime/environment.ts';
import { skipUnavailableToolchain } from '../../sandbox/test-support/infrastructure.ts';

export function toolchainEnvironment(t: TestContext) {
  if (skipUnavailableToolchain(t, configuredToolchainImage())) return undefined;
  return defaultHarnessEnvironment(process.env.SURFPOOL_BINARY ?? join(process.env.HOME ?? '', '.local/bin/surfpool'), 'docker', true);
}
