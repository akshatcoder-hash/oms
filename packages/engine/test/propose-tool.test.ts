import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { createBudgetMeter } from '@oms/core';
import {
  createProposer,
  pinContract,
  EMPTY_SNAPSHOT_DIGEST,
  writeContractFileAtomic,
  type Proposer,
  type TaskContract,
} from '@oms/contract';
import { createHarness } from '../test-support/harness.ts';
import {
  PROPOSE_DONE_TOOL_NAME,
  createProposeDoneExtension,
} from '../src/propose-tool.ts';
import { createSettleExtension, type VerifierPort } from '../src/settle.ts';


interface Project {
  root: string;
  contractPath: string;
  proposer: Proposer;
  readContractText(): string;
  cleanup(): void;
}

function makeProject(t: TestContext): Project {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oms-engine-propose-')));
  const workspaceRoot = join(base, 'workspace');
  const root = join(workspaceRoot, '.oms', 'worktrees', 'task-1');
  const stateRoot = join(workspaceRoot, '.oms', 'tasks', 'task-1');
  const roots = { workspaceRoot, stateRoot, codeRoot: root };
  const outside = join(base, 'outside');
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });

  const contractPath = join(stateRoot, 'task.json');
  const pinFile = join(outside, 'oms-pin.json');

  writeFileSync(join(root, 'tests', 'verifier.test.ts'), "// verifier: do not edit\n");
  writeFileSync(join(root, 'src', 'main.ts'), 'export const amount = 10;\n');

  const contract: TaskContract = {
    version: 0,
    template: 'spl-token',
    items: [
      {
        id: 'item-1',
        title: 'the transfer lands',
        done: [{ kind: 'tests', command: ['npm', 'test'], expect: 'pass' }],
        status: 'active',
        reopenCount: 0,
      },
      {
        id: 'item-2',
        title: 'the account holds 10 tokens',
        done: [{ kind: 'tx', description: 'a mint lands on the surfnet' }],
        status: 'open',
        reopenCount: 0,
      },
    ],
  };
  writeContractFileAtomic(contractPath, contract);

  const pin = pinContract({
    ...roots,
    contractPath: 'task.json',
    verifierPaths: ['tests/verifier.test.ts'],
    evaluatorConfig: {
      schema: 'oms.evaluator/0',
      snapshotDigest: EMPTY_SNAPSHOT_DIGEST,
      codePaths: ['src/main.ts'],
      executionIdentity: 'test:proposal-only',
    },
    pinFile,
  });
  if (!pin.ok) throw new Error(`fixture could not pin: ${pin.code} ${pin.message}`);

  const project: Project = {
    root,
    contractPath,
    proposer: createProposer({ ...roots, pinFile }),
    readContractText: () => readFileSync(contractPath, 'utf8'),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
  t.after(() => project.cleanup());
  return project;
}

function transcript(h: { session: { messages: unknown[] } }): string {
  return JSON.stringify(h.session.messages);
}

test('propose_done proposes the active item; the evaluator, not the tool, closes', async (t) => {
  const project = makeProject(t);
  const extension = createProposeDoneExtension({
    proposer: project.proposer,
    getActiveItemId: () => 'item-1',
  });
  const h = await createHarness({
    extensions: [extension],
    responses: [
      fauxAssistantMessage(fauxToolCall(PROPOSE_DONE_TOOL_NAME, { itemId: 'item-1' })),
      fauxAssistantMessage(fauxText('noted, waiting')),
    ],
  });
  try {
    await h.session.prompt('I am done');
    const read = project.proposer.read();
    assert.ok(read.ok);
    assert.equal(read.value.items[0]?.status, 'proposed', 'active -> proposed');
  } finally {
    h.dispose();
  }
});

test('propose_done rejects a non-active item and leaves the contract unchanged', async (t) => {
  const project = makeProject(t);
  const extension = createProposeDoneExtension({
    proposer: project.proposer,
    getActiveItemId: () => 'item-1',
  });
  const h = await createHarness({
    extensions: [extension],
    responses: [
      fauxAssistantMessage(fauxToolCall(PROPOSE_DONE_TOOL_NAME, { itemId: 'item-2' })),
      fauxAssistantMessage(fauxText('sorry')),
    ],
  });
  try {
    const before = project.readContractText();
    await h.session.prompt('item-2 is done too');
    assert.match(transcript(h), /E_ITEM_NOT_ACTIVE/);
    assert.match(transcript(h), /item-2/);
    assert.equal(project.readContractText(), before, 'a rejected proposal must not write');
    const read = project.proposer.read();
    assert.ok(read.ok);
    assert.equal(read.value.items[0]?.status, 'active');
    assert.equal(read.value.items[1]?.status, 'open');
  } finally {
    h.dispose();
  }
});

test('propose_done fails cleanly when nothing is active', async (t) => {
  const project = makeProject(t);
  const extension = createProposeDoneExtension({
    proposer: project.proposer,
    getActiveItemId: () => null,
  });
  const h = await createHarness({
    extensions: [extension],
    responses: [
      fauxAssistantMessage(fauxToolCall(PROPOSE_DONE_TOOL_NAME, { itemId: 'item-1' })),
      fauxAssistantMessage(fauxText('sorry')),
    ],
  });
  try {
    const before = project.readContractText();
    await h.session.prompt('done');
    assert.match(transcript(h), /E_NO_ACTIVE_ITEM/);
    assert.equal(project.readContractText(), before);
  } finally {
    h.dispose();
  }
});

test('a tampered contract surfaces the store pin error code, unwritten', async (t) => {
  const project = makeProject(t);
  const extension = createProposeDoneExtension({
    proposer: project.proposer,
    getActiveItemId: () => 'item-1',
  });
  const h = await createHarness({
    extensions: [extension],
    responses: [
      fauxAssistantMessage(fauxToolCall(PROPOSE_DONE_TOOL_NAME, { itemId: 'item-1' })),
      fauxAssistantMessage(fauxText('sorry')),
    ],
  });
  try {
    // The generator edits the contract behind the pin's back (eng-review C1).
    writeFileSync(project.contractPath, '{"version":0,"items":[]}');
    const tampered = project.readContractText();
    await h.session.prompt('done');
    assert.match(transcript(h), /E_PIN_MISMATCH/);
    assert.equal(project.readContractText(), tampered, 'the store must not write over a mismatch');
  } finally {
    h.dispose();
  }
});

test('the model-visible tool set has propose_done and no closing tool', async (t) => {
  const project = makeProject(t);
  const extension = createProposeDoneExtension({
    proposer: project.proposer,
    getActiveItemId: () => 'item-1',
  });
  const h = await createHarness({ extensions: [extension], responses: [] });
  try {
    const names = h.session.getAllTools().map((tool) => tool.name);
    assert.ok(names.includes(PROPOSE_DONE_TOOL_NAME), `propose_done registered, got: ${names.join(', ')}`);
    const closers = names.filter(
      (name) =>
        name !== PROPOSE_DONE_TOOL_NAME &&
        /close|evaluat|finish|complete_|set_item|approve/i.test(name),
    );
    assert.deepEqual(closers, [], 'no model-visible tool may close or evaluate an item');
  } finally {
    h.dispose();
  }
});

test('end to end: propose_done then the settle gate verifies and settles, item stays proposed', async (t) => {
  const project = makeProject(t);
  const proposeExtension = createProposeDoneExtension({
    proposer: project.proposer,
    getActiveItemId: () => 'item-1',
  });
  const verifier: VerifierPort = {
    hasProposal: () => {
      const read = project.proposer.read();
      if (!read.ok) return false;
      return read.value.items.some((item) => item.id === 'item-1' && item.status === 'proposed');
    },
    run: async () => ({ status: 'pass', summary: 'verifier green on the pinned snapshot' }),
  };
  const gate = createSettleExtension({
    verifier,
    budget: createBudgetMeter({ clock: () => 1_000 }),
    maxAttempts: 3,
  });
  const h = await createHarness({
    extensions: [proposeExtension, gate],
    responses: [
      fauxAssistantMessage(fauxToolCall(PROPOSE_DONE_TOOL_NAME, { itemId: 'item-1' })),
      fauxAssistantMessage(fauxText('proposed done, awaiting the evaluator')),
      fauxAssistantMessage(fauxText('waiting')),
    ],
  });
  try {
    await h.session.prompt('finish item-1');
    assert.equal(h.faux.state.callCount, 2);
    const read = project.proposer.read();
    assert.ok(read.ok);
    const item = read.value.items.find((entry) => entry.id === 'item-1');
    assert.equal(item?.status, 'proposed', 'nothing in the generator path may close the item');
    assert.equal(gate.getState().lastDecision?.reason, 'verifier_passed');
  } finally {
    h.dispose();
  }
});

for (const endRunOnProposal of [true, false]) {
  test(`a proposal ${endRunOnProposal ? 'ends the run before another model turn' : 'still gets a model reply by default'}, and the settle gate verifies either way`, async (t) => {
    const project = makeProject(t);
    let verified = 0;
    const verifier: VerifierPort = {
      hasProposal: () => {
        const read = project.proposer.read();
        return read.ok && read.value.items.some(item => item.status === 'proposed');
      },
      run: async () => { verified++; return { status: 'pass', summary: 'all verifier tests passed' }; },
    };
    const h = await createHarness({
      extensions: [createProposeDoneExtension({ proposer: project.proposer, getActiveItemId: () => 'item-1', endRunOnProposal }),
        createSettleExtension({ verifier, budget: createBudgetMeter({ clock: () => 1_000_000 }), maxAttempts: 3 })],
      responses: [
        fauxAssistantMessage(fauxToolCall(PROPOSE_DONE_TOOL_NAME, { itemId: 'item-1' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Proposed; waiting for the verdict.')),
      ],
    });
    try {
      await h.session.prompt('finish');
      assert.equal(h.faux.state.callCount, endRunOnProposal ? 1 : 2);
      assert.equal(verified, 1, 'the verifier ran exactly once at the settle boundary');
    } finally {
      h.dispose();
    }
  });
}
