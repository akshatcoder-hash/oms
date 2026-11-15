import { execFileSync } from "node:child_process";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Pre-done edge-case check (pilot feature A3). When the change touches a Solana program, the first propose_done is held back
 * once: the model gets a fixed, task-independent brief to write and run edge-case tests and fix what fails, bounded to two model
 * turns and three minutes. After the bound only propose_done and task_status run. The verdict is still the offline verifier's.
 */
export const EDGE_CHECK_LIMITS = { turns: 2, ms: 180_000 } as const;
const EDGE_CHECK_BRIEF = "Not yet: this change touches a Solana program, so first run a short edge-case pass " +
  `(at most ${EDGE_CHECK_LIMITS.turns} turns and ${EDGE_CHECK_LIMITS.ms / 60_000} minutes). Write and run tests on Surfpool ($SURFNET_RPC_URL) ` +
  "or with the project's own test setup, for each case that applies to the changed instructions: missing signer, wrong account owner, " +
  "bad PDA seeds or bump, arithmetic overflow, and close then re-init of an account. Fix what fails, then call propose_done again. " +
  "Do not edit the pinned verifier.";
const OVER = "The edge-case pass is over; call propose_done now.";
const ALWAYS_ALLOWED = new Set(["propose_done", "task_status"]);

/** Edge-case pass outcome for the run record: `result` is the last command's exit inside the pass (`none` when none ran). */
export interface EdgeCheckSummary { triggered: boolean; turns: number; ms: number; result: "pass" | "fail" | "none" }

const EXCLUDED = /^(target|\.oms-cargo|node_modules)\//;
export const changesProgram = (paths: readonly string[]) => paths.some(path => path.endsWith(".rs") && !EXCLUDED.test(path));

/** Paths changed against the task base: tracked edits plus new untracked files. */
export function gitChangedPaths(codeRoot: string, baseOid: string): string[] {
  const git = (...args: string[]) => execFileSync("git", ["-C", codeRoot, ...args], { encoding: "utf8", maxBuffer: 16 << 20 });
  return [...git("diff", "--name-only", baseOid).split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")].filter(Boolean);
}

export function createEdgeCheck(options: { changedPaths(): string[]; clock?: () => number }) {
  const clock = options.clock ?? Date.now;
  type Phase = { at: "idle" } | { at: "running"; started: number; turns: number; countFrom: boolean; result: EdgeCheckSummary["result"] }
    | { at: "done"; summary: EdgeCheckSummary };
  let phase: Phase = { at: "idle" };
  const over = (p: Extract<Phase, { at: "running" }>) => p.turns >= EDGE_CHECK_LIMITS.turns || clock() - p.started >= EDGE_CHECK_LIMITS.ms;
  const summary = (): EdgeCheckSummary => phase.at === "done" ? phase.summary : phase.at === "idle"
    ? { triggered: false, turns: 0, ms: 0, result: "none" }
    : { triggered: true, turns: phase.turns, ms: clock() - phase.started, result: phase.result };
  const extension: ExtensionFactory = pi => {
    pi.on("tool_call", event => {
      if (event.toolName === "propose_done") {
        if (phase.at === "idle" && changesProgram(options.changedPaths())) {
          phase = { at: "running", started: clock(), turns: 0, countFrom: false, result: "none" };
          return { block: true, reason: EDGE_CHECK_BRIEF };
        }
        if (phase.at === "running") phase = { at: "done", summary: summary() };
        return undefined;
      }
      if (phase.at === "running" && over(phase) && !ALWAYS_ALLOWED.has(event.toolName)) return { block: true, reason: OVER };
      return undefined;
    });
    pi.on("tool_result", event => {
      if (phase.at === "running" && event.toolName === "bash") phase.result = event.isError ? "fail" : "pass";
      return undefined;
    });
    pi.on("turn_end", () => {
      // The turn that called propose_done is not part of the pass.
      if (phase.at === "running") phase.countFrom ? phase.turns++ : phase.countFrom = true;
    });
  };
  return { extension, summary };
}
