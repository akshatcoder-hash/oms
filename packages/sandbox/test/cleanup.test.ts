import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasLeftovers, removeTaskResources, recoverTaskExecutionResources } from '../src/cleanup.ts';
import type { DockerClient } from '../src/docker.ts';
import { SandboxError } from '../src/errors.ts';

function daemon(volume: unknown, failure?: string) {
  const calls: string[][] = [];
  const client: DockerClient = {
    async out(args) {
      calls.push(args);
      if (args[0] === 'ps' || args[1] === 'ls') {
        assert.ok(args.includes('label=oms.task=owner'));
        assert.ok(args.includes('label=oms.component=sandbox'));
        if (failure === 'list') throw new SandboxError('E_DOCKER', 'daemon lookup unavailable');
        return args[0] === 'volume' ? 'owned-volume\n' : '';
      }
      if (args[0] === 'volume' && args[1] === 'inspect') {
        if (failure === 'inspect') throw new SandboxError('E_DOCKER', 'volume lookup unavailable');
        return JSON.stringify(volume);
      }
      if (args[0] === 'volume' && args[1] === 'rm') return '';
      assert.fail(`unexpected operation ${JSON.stringify(args)}`);
    },
    async capture() { assert.fail('cleanup must not execute containers'); },
  };
  return { client, calls };
}

test('explicit task cleanup checks both ownership labels and exact volume metadata', async () => {
  const { client, calls } = daemon({ Name: 'owned-volume', Labels: { 'oms.component': 'sandbox', 'oms.task': 'owner' } });
  assert.deepEqual(await removeTaskResources('owner', client), { containers: [], networks: [], volumes: ['owned-volume'] });
  assert.ok(calls.some(a => a[0] === 'volume' && a[1] === 'rm' && a[2] === 'owned-volume'));
});

test('cleanup never removes foreign or misidentified volumes returned by discovery', async () => {
  for (const volume of [
    { Name: 'owned-volume', Labels: { 'oms.component': 'elsewhere', 'oms.task': 'owner' } },
    { Name: 'owned-volume', Labels: { 'oms.component': 'sandbox', 'oms.task': 'foreign' } },
    { Name: 'other-volume', Labels: { 'oms.component': 'sandbox', 'oms.task': 'owner' } },
  ]) {
    const { client, calls } = daemon(volume);
    await assert.rejects(removeTaskResources('owner', client), { code: 'E_RESOURCE_OWNERSHIP' });
    assert.ok(!calls.some(a => a[1] === 'rm'));
  }
});

test('cleanup and leftovers lookup failures are errors, never successful emptiness', async () => {
  for (const failure of ['list', 'inspect']) {
    const { client, calls } = daemon({}, failure);
    await assert.rejects(removeTaskResources('owner', client), { code: 'E_DOCKER' });
    assert.ok(!calls.some(a => a[1] === 'rm'));
  }
  await assert.rejects(hasLeftovers('owner', daemon({}, 'list').client), { code: 'E_DOCKER' });
});

function recoveryDaemon(foreignMember = false) {
  const calls: string[][] = [];
  const ids = { container: 'a'.repeat(64), network: 'b'.repeat(64) };
  const present = new Set(['container', 'network']);
  const labels = { 'oms.component': 'sandbox', 'oms.task': 'owner', 'oms.execution': 'owned-run', 'oms.phase': 'run' };
  const client: DockerClient = {
    async out(args) {
      calls.push(args);
      assert.ok(!args.includes('volume'), 'recovery must never touch volumes');
      if (args[0] === 'ps') return present.has('container') ? 'oms-owner-run' : '';
      if (args[0] === 'network' && args[1] === 'ls') return present.has('network') ? 'oms-owner-net' : '';
      if (args[0] === 'inspect') return JSON.stringify({ Id: ids.container, Name: '/oms-owner-run', Config: { Labels: labels } });
      if (args[0] === 'network' && args[1] === 'inspect') return JSON.stringify({
        Id: ids.network, Name: 'oms-owner-net', Labels: labels,
        Containers: { [foreignMember ? 'c'.repeat(64) : ids.container]: {} },
      });
      if (args[0] === 'rm') { assert.deepEqual(args, ['rm', '-f', ids.container]); present.delete('container'); return ''; }
      if (args[0] === 'network' && args[1] === 'rm') {
        assert.deepEqual(args, ['network', 'rm', ids.network]); present.delete('network'); return '';
      }
      assert.fail(`unexpected recovery operation ${JSON.stringify(args)}`);
    },
    async capture() { assert.fail('recovery must not execute new containers'); },
  };
  return { client, calls };
}

test('startup recovery deletes only inspected immutable execution IDs, never volumes', async () => {
  const { client, calls } = recoveryDaemon();
  let ownershipChecks = 0;
  assert.deepEqual(await recoverTaskExecutionResources('owner', () => { ownershipChecks++; }, client),
    { containers: ['oms-owner-run'], networks: ['oms-owner-net'] });
  assert.equal(ownershipChecks, 4);
  assert.ok(calls.every(args => !args.includes('-v')));
});

test('startup recovery refuses foreign network members before removing any execution', async () => {
  const { client, calls } = recoveryDaemon(true);
  await assert.rejects(recoverTaskExecutionResources('owner', () => {}, client), { code: 'E_RESOURCE_OWNERSHIP' });
  assert.ok(!calls.some(args => args.includes('rm')));
});

test('changed recovery ownership prevents any resource removal', async () => {
  const { client, calls } = recoveryDaemon();
  await assert.rejects(recoverTaskExecutionResources('owner', () => { throw new Error('owner changed'); }, client), /owner changed/);
  assert.ok(!calls.some(args => args.includes('rm')));
});
