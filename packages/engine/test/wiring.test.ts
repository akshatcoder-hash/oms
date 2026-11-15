import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { DEFAULT_BUDGET_CAPS, createTraceWriter, parseTrace, snapshotFor } from "@oms/core";
import {
  createEvaluator,
  createProposer,
  pinContract,
  sha256Hex,
  EMPTY_SNAPSHOT_DIGEST,
  writeContractFileAtomic,
  type TaskContract,
} from "@oms/contract";
import { createEvaluatorVerifierPort } from "../src/verifier.ts";
import { makeProject } from "../../contract/test-support/fixture.ts";
import { createHarness } from "../test-support/harness.ts";
import {
  createOmsExtensions,
  createVerifierRunner,
  type SandboxPort,
  type SandboxResult,
  type SurfnetFactory,
} from "../src/index.ts";

const SNAPSHOT_DIGEST = EMPTY_SNAPSHOT_DIGEST;

interface Wired {
  root: string;
  tracePath: string;
  contract(): TaskContract;
  extensions: ReturnType<typeof createOmsExtensions>;
  starts: () => number;
  stops: () => number;
  sandboxCalls: string[][];
}

function wire(t: TestContext, sandboxResults: SandboxResult[], items?: TaskContract["items"]): Wired {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "oms-engine-wiring-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const workspaceRoot = join(base, "workspace");
  const root = join(workspaceRoot, ".oms", "worktrees", "task-1");
  const stateRoot = join(workspaceRoot, ".oms", "tasks", "task-1");
  const roots = { workspaceRoot, stateRoot, codeRoot: root };
  mkdirSync(stateRoot, { recursive: true });
  const outside = join(base, "outside");
  mkdirSync(join(root, ".oms"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "tests", "verifier.test.ts"), "// verifier\n");
  writeFileSync(join(root, "src", "main.ts"), "export const amount = 10;\n");
  const contractPath = join(stateRoot, "task.json");
  const pinFile = join(outside, "oms-pin.json");
  writeContractFileAtomic(contractPath, {
    version: 0,
    template: "spl-token",
    items: items ?? [
      {
        id: "item-1",
        title: "the transfer lands",
        done: [{ kind: "tests", command: ["npm", "test"], expect: "pass" }],
        status: "active",
        reopenCount: 0,
      },
    ],
  });
  const pin = pinContract({
    ...roots,
    contractPath: "task.json",
    verifierPaths: ["tests/verifier.test.ts"],
    evaluatorConfig: { schema: "oms.evaluator/0", snapshotDigest: SNAPSHOT_DIGEST, codePaths: ["src/main.ts"], executionIdentity: "test:controlled" },
    pinFile,
  });
  if (!pin.ok) throw new Error(`pin failed: ${pin.code} ${pin.message}`);

  let started = 0;
  let stopped = 0;
  const surfnets: SurfnetFactory = {
    async start() {
      started += 1;
      return { port: 18899, mode: "offline-snapshot", snapshotDigest: SNAPSHOT_DIGEST, call: async () => null, stop: async () => void (stopped += 1) };
    },
  };
  const sandboxCalls: string[][] = [];
  const queue = [...sandboxResults];
  const sandbox: SandboxPort = {
    async run(argv) {
      sandboxCalls.push(argv);
      const next = queue.shift();
      if (!next) throw new Error("sandbox called more times than scripted");
      return next;
    },
  };

  const evaluator = createEvaluator({ ...roots, pinFile, runner: createVerifierRunner({ surfnets, sandbox, executionIdentity: "test:controlled" }) });
  const proposer = createProposer({ ...roots, pinFile });
  const tracePath = join(outside, "trace.jsonl");
  const trace = createTraceWriter({ path: tracePath, clock: Date.now });
  t.after(() => void trace.close());
  const extensions = createOmsExtensions({
    proposer,
    evaluator,
    cwd: root,
    trace,
    budget: { snapshot: () => snapshotFor(DEFAULT_BUDGET_CAPS, { tokens: 0, spendMicroUsd: 0, wallClockMs: 0 }) },
    protectedPaths: [join(root, "tests"), contractPath],
  });
  return {
    root,
    tracePath,
    contract: () => JSON.parse(readFileSync(contractPath, "utf8")) as TaskContract,
    extensions,
    starts: () => started,
    stops: () => stopped,
    sandboxCalls,
  };
}

const ok = (): SandboxResult => ({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
const bad = (): SandboxResult => ({ exitCode: 1, stdout: "", stderr: "expected 10 got 9", timedOut: false });

test("fail then pass: the gate sends the model back once, then the evaluator closes the item", async (t) => {
  const w = wire(t, [bad(), ok()]);
  const h = await createHarness({
    extensions: w.extensions.extensions,
    responses: [
      fauxAssistantMessage(fauxToolCall("propose_done", { itemId: "item-1" })),
      fauxAssistantMessage(fauxText("waiting for the verdict")),
      fauxAssistantMessage(fauxToolCall("propose_done", { itemId: "item-1" })),
      fauxAssistantMessage(fauxText("done")),
    ],
  });
  try {
    await h.session.prompt("build it");
    const item = w.contract().items[0];
    assert.equal(item?.status, "closed");
    assert.equal(item?.reopenCount, 1);
    assert.equal(w.sandboxCalls.length, 2);
    assert.equal(w.starts(), 2, "every run gets a fresh surfnet");
    assert.equal(w.stops(), 2, "and tears it down");
    assert.match(JSON.stringify(h.session.messages), /expected 10 got 9/);
    const parsed = parseTrace(readFileSync(w.tracePath, "utf8"));
    assert.ok(parsed.events.some((e) => e.type === "settle"));
  } finally {
    h.dispose();
  }
});

test("a verifier that keeps failing the same way stops and asks the user", async (t) => {
  const w = wire(t, [bad(), bad(), bad(), bad(), bad()]);
  const h = await createHarness({
    extensions: w.extensions.extensions,
    responses: Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0
        ? fauxAssistantMessage(fauxToolCall("propose_done", { itemId: "item-1" }))
        : fauxAssistantMessage(fauxText("waiting")),
    ),
  });
  try {
    await h.session.prompt("build it");
    assert.notEqual(w.contract().items[0]?.status, "closed");
    const state = w.extensions.settle.getState();
    assert.equal(state.lastDecision?.askUser, true);
    assert.ok(h.faux.state.callCount < 12, "the loop must stop, not run the script out");
  } finally {
    h.dispose();
  }
});

test("a tx-only item can never be closed by the machine verifier", async (t) => {
  const w = wire(t, [], [
    {
      id: "item-1",
      title: "a mint lands",
      done: [{ kind: "tx", description: "a mint lands on the surfnet" }],
      status: "active",
      reopenCount: 0,
    },
  ]);
  const h = await createHarness({
    extensions: w.extensions.extensions,
    responses: Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0
        ? fauxAssistantMessage(fauxToolCall("propose_done", { itemId: "item-1" }))
        : fauxAssistantMessage(fauxText("waiting")),
    ),
  });
  try {
    await h.session.prompt("build it");
    assert.notEqual(w.contract().items[0]?.status, "closed");
  } finally {
    h.dispose();
  }
});

test("the model cannot edit the pinned verifier or read signer key material", async (t) => {
  const w = wire(t, []);
  const h = await createHarness({
    extensions: w.extensions.extensions,
    responses: [
      fauxAssistantMessage(
        fauxToolCall("write", { path: join(w.root, "tests", "verifier.test.ts"), content: "// always pass\n" }),
      ),
      fauxAssistantMessage(fauxToolCall("read", { path: join(process.env.HOME ?? "/", ".config", "solana", "id.json") })),
      fauxAssistantMessage(fauxText("ok")),
    ],
  });
  try {
    await h.session.prompt("cheat");
    assert.equal(readFileSync(join(w.root, "tests", "verifier.test.ts"), "utf8"), "// verifier\n");
    const text = JSON.stringify(h.session.messages);
    assert.match(text, /protected_write|protected/i);
    assert.match(text, /denied_root|denied/i);
  } finally {
    h.dispose();
  }
});

test("unreadable proposed state is an unavailable verifier, not no proposal", async () => {
  const port = createEvaluatorVerifierPort({ evaluator: {
    read: () => ({ ok: false, issues: [{ path: "", code: "E_CONTRACT_PATH", message: "unreadable" }] }),
    evaluate: async () => { throw new Error("must not evaluate unreadable state"); },
    reopen: () => { throw new Error("must not mutate unreadable state"); },
  } });
  assert.equal(port.hasProposal?.(), true);
  assert.deepEqual(await port.run(), { status: "unavailable", summary: "contract state unreadable: E_CONTRACT_PATH: unreadable" });
});

for (const observation of ["forked", "wrong-digest", "changed-file"] as const) {
  test(`runner refuses offline proof for ${observation} snapshot observation`, async (t) => {
    const p = makeProject();
    t.after(() => p.cleanup());
    let stops = 0;
    const runner = createVerifierRunner({
      executionIdentity: "test:controlled",
      surfnets: { async start(path) {
        assert.ok(path);
        const loadedDigest = sha256Hex(readFileSync(path));
        if (observation === "changed-file") writeFileSync(path, "substituted snapshot");
        return {
          port: 18899,
          mode: observation === "forked" ? "forked" : "offline-snapshot",
          snapshotDigest: observation === "wrong-digest" ? sha256Hex("other") : loadedDigest,
          call: async () => null,
          stop: async () => { stops++; },
        };
      } },
      sandbox: { async run(_argv, opts) {
        assert.notEqual(opts.codeRoot, p.root);
        assert.equal(readFileSync(join(opts.codeRoot, "src/main.ts"), "utf8"), "export const amount = 10;\n");
        return ok();
      } },
    });
    const evaluator = createEvaluator({ ...p.roots, pinFile: p.pinFile, runner });
    createProposer({ ...p.roots, pinFile: p.pinFile }).propose("item-1");
    const result = await evaluator.evaluate("item-1");
    assert.equal(result.closed, false);
    assert.equal(result.reason, observation === "forked" ? "forked-evidence" : observation === "changed-file" ? "inputs-changed" : "runner-error");
    assert.equal(stops, 1);
  });
}

test("a stale closure cannot take the settle gate no-proposal shortcut", async (t) => {
  const p = makeProject(); t.after(() => p.cleanup());
  const runner = createVerifierRunner({
    executionIdentity: "test:controlled",
    surfnets: { async start(path) { return {
      port: 18899, mode: "offline-snapshot", snapshotDigest: sha256Hex(readFileSync(path!)),
      call: async () => null, stop: async () => {},
    }; } },
    sandbox: { async run() { return ok(); } },
  });
  const evaluator = createEvaluator({ ...p.roots, pinFile: p.pinFile, runner });
  createProposer({ ...p.roots, pinFile: p.pinFile }).propose("item-1");
  assert.equal((await evaluator.evaluate("item-1")).closed, true);
  writeFileSync(p.codePath, "export const amount = 0;");
  const port = createEvaluatorVerifierPort({ evaluator });
  assert.equal(port.hasProposal?.(), true);
  assert.equal((await port.run()).status, "unavailable");
});

test("runtime adapter identity must match the pinned evaluator configuration", async (t) => {
  const p = makeProject(); t.after(() => p.cleanup());
  const evaluator = createEvaluator({ ...p.roots, pinFile: p.pinFile, runner: createVerifierRunner({
    executionIdentity: "different-runtime",
    surfnets: { async start() { throw new Error("must refuse before startup"); } },
    sandbox: { async run() { throw new Error("must refuse before execution"); } },
  }) });
  createProposer({ ...p.roots, pinFile: p.pinFile }).propose("item-1");
  const result = await evaluator.evaluate("item-1");
  assert.equal(result.reason, "evidence-not-bound");
  if (result.reason === "evidence-not-bound") assert.match(result.detail, /execution identity/);
});
