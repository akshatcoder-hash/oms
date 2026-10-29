import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createHarness } from "../test-support/harness.ts";

test("faux provider drives a session end to end", async () => {
  const h = await createHarness({
    extensions: [],
    responses: [fauxAssistantMessage(fauxText("hello from faux"))],
  });
  try {
    await h.session.prompt("hi");
    assert.equal(h.faux.state.callCount, 1);
    assert.match(h.session.getLastAssistantText() ?? "", /hello from faux/);
  } finally {
    h.dispose();
  }
});

test("tool_call hook can block a tool and the model sees the block", async () => {
  const seen: string[] = [];
  const h = await createHarness({
    extensions: [
      (pi) => {
        pi.on("tool_call", async (event) => {
          seen.push(event.toolName);
          return { block: true, reason: "blocked by test" };
        });
      },
    ],
    responses: [
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo should-not-run" })),
      fauxAssistantMessage(fauxText("ok")),
    ],
    tools: ["bash"],
  });
  try {
    await h.session.prompt("run it");
    assert.deepEqual(seen, ["bash"]);
    const results = h.session.messages.filter((m) => m.role === "toolResult");
    assert.equal(results.length, 1);
    assert.match(JSON.stringify(results[0]), /blocked by test/);
    assert.ok(!JSON.stringify(results[0]).includes("should-not-run\\n"));
  } finally {
    h.dispose();
  }
});

test("agent_before_settle can request one more model request", async () => {
  let asked = 0;
  let canContinue: boolean | undefined;
  const h = await createHarness({
    extensions: [
      (pi) => {
        pi.on("agent_before_settle", async (event) => {
          asked += 1;
          if (asked === 1) {
            canContinue = event.context.canContinue;
            return {
              continue: true,
              entries: [
                { type: "custom_message", customType: "oms-verifier", content: "verifier failed: fix it", display: false },
              ],
            };
          }
          return undefined;
        });
      },
    ],
    responses: [fauxAssistantMessage(fauxText("first")), fauxAssistantMessage(fauxText("second"))],
  });
  try {
    await h.session.prompt("go");
    assert.equal(h.faux.state.callCount, 2);
    assert.equal(asked >= 1, true, `canContinue=${canContinue}`);
  } finally {
    h.dispose();
  }
});
