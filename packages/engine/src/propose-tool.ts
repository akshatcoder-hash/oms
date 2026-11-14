/**
 * `propose_done`: the generator's only "done" channel (SPEC 3, generator/evaluator
 * rule; eng-review C1).
 *
 * The model can never close an item. The most it can do is propose that the
 * currently active item is done; the evaluator closes it only when the verifier
 * passes on a pinned snapshot. This extension registers that one tool and
 * enforces the one-active-item rule at the tool boundary, before the proposer
 * (and its pin check) is even reached.
 */

import { Type } from '@earendil-works/pi-ai';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { Proposer } from '@oms/contract';

export const PROPOSE_DONE_TOOL_NAME = 'propose_done';

/** The slice of `@oms/contract`'s `Proposer` this tool needs. */
export type ProposerPort = Pick<Proposer, 'propose'>;

export interface ProposeDoneOptions {
  /** Generator-facing contract surface (active -> proposed, nothing else). */
  proposer: ProposerPort;
  /** Id of the currently active item, or null/undefined when nothing is active. */
  getActiveItemId(): string | null | undefined;
  /** End the agent run after a successful proposal, so the evaluator answers without another model turn. */
  endRunOnProposal?: boolean;
}

export interface ProposeDoneParams {
  itemId: string;
  note?: string;
}

const parameters = Type.Object({
  itemId: Type.String({ description: 'Id of the currently active contract item to propose as done' }),
  note: Type.Optional(Type.String({ description: 'Optional note for the evaluator' })),
});

/**
 * Register `propose_done`. Rejections throw so the model sees a tool error
 * carrying the contract's error code; a successful call changes nothing but the
 * item's status (`active` -> `proposed`) and tells the model to wait.
 */
export function createProposeDoneExtension(options: ProposeDoneOptions): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: PROPOSE_DONE_TOOL_NAME,
      label: 'Propose done',
      description:
        'Propose that the currently active contract item is done. You cannot close items: the evaluator ' +
        'runs the verifier and closes an item only on bound, passing evidence. Only the currently active ' +
        'item can be proposed; any other id is an error. Once this succeeds, stop editing and wait for the ' +
        "evaluator's verdict.",
      parameters,
      async execute(_toolCallId, params: ProposeDoneParams) {
        const { itemId } = params;
        const active = options.getActiveItemId();
        if (active === null || active === undefined || active === '') {
          throw new Error(
            'propose_done rejected (E_NO_ACTIVE_ITEM): no item is currently active, so nothing can be proposed done',
          );
        }
        if (itemId !== active) {
          throw new Error(
            `propose_done rejected (E_ITEM_NOT_ACTIVE): item "${itemId}" is not the active item ` +
              `"${active}"; only the currently active item can be proposed done`,
          );
        }
        const result = options.proposer.propose(itemId);
        if (!result.ok) {
          throw new Error(`propose_done rejected (${result.code}): ${result.message}`);
        }
        return {
          content: [
            {
              type: 'text',
              text:
                `Item "${itemId}" is now proposed done. The evaluator will verify it against the pinned ` +
                'contract, verifier and snapshot digests and close it only if the verifier passes. ' +
                'Stop editing until the evaluator reports its verdict.',
            },
          ],
          details: undefined,
          ...(options.endRunOnProposal ? { terminate: true } : {}),
        };
      },
    });
  };
}
