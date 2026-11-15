import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { TestContext } from 'node:test';
import { dockerInfoWorks } from '../src/docker.ts';

export type Infrastructure = 'DOCKER' | 'SURFPOOL';

export interface InfrastructureNeeds {
  /** Pinned image references for the Docker work; an unset reference makes Docker unavailable. */
  docker?: readonly (string | undefined)[];
  /** Surfpool binary path; an unset or nonexistent path makes Surfpool unavailable. */
  surfpool?: string | undefined;
}

let daemon: Promise<boolean> | undefined;

/**
 * Skips the test when needed infrastructure is unavailable, unless
 * OMS_REQUIRE_DOCKER=1 or OMS_REQUIRE_SURFPOOL=1 demands it, in which case the
 * absence fails the test. Returns true when the test was skipped.
 * It does not narrow its inputs, so callers repeat their truthiness checks
 * after it for the compiler only.
 */
export async function skipUnavailable(t: TestContext, needs: InfrastructureNeeds): Promise<boolean> {
  const gaps: Array<[Infrastructure, string]> = [];
  if ('surfpool' in needs && !(needs.surfpool && existsSync(needs.surfpool))) {
    gaps.push(['SURFPOOL', `Surfpool binary unavailable (${needs.surfpool || 'SURFPOOL_BINARY unset'})`]);
  }
  if (needs.docker) {
    if (needs.docker.some((image) => !image))
      gaps.push(['DOCKER', 'pinned OMS_SANDBOX_IMAGE / OMS_SANDBOX_FORWARDER_IMAGE unset']);
    else if (!(await (daemon ??= dockerInfoWorks()))) gaps.push(['DOCKER', 'Docker daemon unavailable']);
  }
  const required = gaps.filter(([infrastructure]) => process.env[`OMS_REQUIRE_${infrastructure}`] === '1');
  if (required.length > 0)
    throw new Error(required.map(([name, reason]) => `OMS_REQUIRE_${name}=1 but ${reason}`).join('; '));
  if (gaps.length === 0) return false;
  t.skip(gaps.map(([, reason]) => reason).join('; '));
  return true;
}

/** Toolchain builds are opt-in independently of the Node Docker integration suite. */
export function skipUnavailableToolchain(t: TestContext, image: string | undefined): boolean {
  if (image) return false;
  const reason = 'No local toolchain image; run scripts/build-toolchain.sh or set OMS_TOOLCHAIN_IMAGE';
  if (process.env.OMS_REQUIRE_TOOLCHAIN === '1') throw new Error(`OMS_REQUIRE_TOOLCHAIN=1 but ${reason}`);
  t.skip(reason);
  return true;
}

/** Review-tools checks are opt-in like toolchain builds. Returns a node:test
 * `skip` option; false runs the test. OMS_REQUIRE_REVIEW_TOOLS=1 fails on a
 * missing image; it or OMS_REQUIRE_DOCKER=1 fails when Docker lacks the image. */
export function reviewToolsSkip(image: string | undefined): string | false {
  const required = process.env.OMS_REQUIRE_REVIEW_TOOLS === '1';
  if (!image) {
    const reason = 'No local review-tools image; run scripts/build-review-tools.sh or set OMS_REVIEW_TOOLS_IMAGE';
    if (required) throw new Error(`OMS_REQUIRE_REVIEW_TOOLS=1 but ${reason}`);
    return reason;
  }
  if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status === 0) return false;
  if (required || process.env.OMS_REQUIRE_DOCKER === '1')
    throw new Error('Required review-tools image is not present in Docker');
  return 'Review-tools image is not present in Docker';
}
