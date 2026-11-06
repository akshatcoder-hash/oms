import { MODEL_POLICY_VERSION } from './catalog.ts';

export type DispatchRole = 'router' | 'planner' | 'candidate' | 'synthesizer' | 'worker';

export interface ModelIdentity {
  readonly provider: string;
  readonly modelId: string;
  readonly endpointId: string;
}

export interface DispatchIdentity extends ModelIdentity {
  readonly dispatchId: string;
  readonly logicalTurnId: string;
  readonly attempt: number;
  readonly role: DispatchRole;
  readonly policyVersion: string;
}

export type DispatchAllocator = (turnId: string, role: DispatchRole, model: ModelIdentity) => DispatchIdentity;

/** One allocator per live session, seeded with every durable reservation when resuming. */
export function createDispatchAllocator(
  previous: readonly { readonly logicalTurnId: string; readonly attempt: number }[] = [],
): DispatchAllocator {
  const attempts = new Map<string, number>();
  for (const reservation of previous) {
    if (typeof reservation.logicalTurnId !== 'string' || reservation.logicalTurnId.length === 0 ||
        !Number.isSafeInteger(reservation.attempt) || reservation.attempt <= 0) {
      throw new Error('Invalid dispatch allocation history');
    }
    attempts.set(reservation.logicalTurnId, Math.max(attempts.get(reservation.logicalTurnId) ?? 0, reservation.attempt));
  }
  return (turnId, role, model) => {
    if (typeof turnId !== 'string' || turnId.length === 0 ||
        !['router', 'planner', 'candidate', 'synthesizer', 'worker'].includes(role) ||
        !model || ![model.provider, model.modelId, model.endpointId].every((value) => typeof value === 'string' && value.length > 0)) {
      throw new Error('Invalid dispatch identity');
    }
    const attempt = (attempts.get(turnId) ?? 0) + 1;
    if (!Number.isSafeInteger(attempt)) throw new Error('Dispatch attempt range exhausted');
    const dispatchId = globalThis.crypto.randomUUID();
    attempts.set(turnId, attempt);
    return Object.freeze({ dispatchId, logicalTurnId: turnId, attempt, role,
      provider: model.provider, modelId: model.modelId, endpointId: model.endpointId,
      policyVersion: MODEL_POLICY_VERSION });
  };
}
