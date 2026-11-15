import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  createBudgetMeter,
  createDeepRedactor,
  type BudgetCaps,
  type BudgetMeter,
  type TraceWriter,
} from "@oms/core";
import type { Evaluator, Proposer } from "@oms/contract";
import { createGuardsExtension, type GuardsConfig } from "./guards.ts";
import { createProposeDoneExtension } from "./propose-tool.ts";
import { createSettleExtension, type SettleExtension, type SettleTraceSink } from "./settle.ts";
import { createTraceExtension } from "./trace-extension.ts";
import { createEvaluatorVerifierPort } from "./verifier.ts";

/** Key material and oms state that no model-reachable tool may read or write. */
export function defaultDeniedRoots(extra: readonly string[] = []): string[] {
  const home = homedir();
  return [
    join(home, ".config", "solana"),
    join(home, ".ssh"),
    join(home, ".oms"),
    join(home, ".gnupg"),
    ...extra,
  ];
}

export interface OmsExtensionOptions {
  /** Generator-facing contract surface. */
  proposer: Proposer;
  /** Evaluator-facing surface; only the settle gate calls it, never a model tool. */
  evaluator: Evaluator;
  /** Absolute project root; used as the base for relative guard paths. */
  cwd: string;
  trace: TraceWriter;
  /** Files the model must not write: the pinned verifier, contract, snapshot. */
  protectedPaths: readonly string[];
  /** Signer socket dir, spend journal, keypair dirs. Merged with `defaultDeniedRoots`. */
  deniedRoots?: readonly string[];
  /** Secret byte strings to scrub from traces and from what the model sees. */
  secrets?: readonly Uint8Array[];
  budget?: Pick<BudgetMeter, "snapshot">;
  budgetCaps?: BudgetCaps;
  maxAttempts?: number;
  /** Bounded runs stop at a successful propose_done; the settle gate then verifies without a closing model reply. */
  endRunOnProposal?: boolean;
  guards?: Pick<GuardsConfig, "repetition" | "maxEditBytes" | "approveHostCommands">;
  now?: () => number;
  /** Extra extensions composed after the core ones. */
  extra?: readonly ExtensionFactory[];
}

export interface OmsExtensions {
  extensions: ExtensionFactory[];
  settle: SettleExtension;
  budget: Pick<BudgetMeter, "snapshot">;
}

/** Verifier runs one retry loop may use; shared by the settle gate and the TUI `/goal` loop. */
export const DEFAULT_MAX_ATTEMPTS = 5;

function activeItemId(proposer: Proposer): string | null {
  const read = proposer.read();
  if (!read.ok) return null;
  return read.value.items.find((i) => i.status === "active")?.id ?? null;
}

/**
 * Compose the oms Pi extensions. Order matters: guards run before the tool
 * executes, trace sees every event, and the settle gate is the only place a
 * session can end after a proposal.
 */
export function createOmsExtensions(options: OmsExtensionOptions): OmsExtensions {
  const now = options.now ?? Date.now;
  const budget =
    options.budget ??
    createBudgetMeter({ clock: now, ...(options.budgetCaps ? { caps: options.budgetCaps } : {}) });
  const redact = createDeepRedactor(options.secrets ?? []);

  const settleTrace: SettleTraceSink = {
    append: (event) => options.trace.append(event),
  };
  const settle = createSettleExtension({
    verifier: createEvaluatorVerifierPort({ evaluator: options.evaluator }),
    budget,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    trace: settleTrace,
    redact: (text) => redact(text) as string,
    now,
  });

  const extensions: ExtensionFactory[] = [
    createGuardsExtension({
      protectedPaths: options.protectedPaths,
      deniedRoots: defaultDeniedRoots(options.deniedRoots),
      cwd: options.cwd,
      ...options.guards,
    }),
    createProposeDoneExtension({
      proposer: options.proposer,
      getActiveItemId: () => activeItemId(options.proposer),
      endRunOnProposal: options.endRunOnProposal,
    }),
    createTraceExtension({ writer: options.trace, redact, redactModelView: true }),
    ...(options.extra ?? []),
    settle,
  ];
  return { extensions, settle, budget };
}
