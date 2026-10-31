/**
 * Error taxonomy for @oms/sandbox.
 */

export type SandboxErrorCode =
  | 'E_MOUNT_FORBIDDEN'
  | 'E_MOUNT_SYMLINK_ESCAPE'
  | 'E_MOUNT_MISSING'
  | 'E_MOUNT_OUTSIDE_PROJECT'
  | 'E_MOUNT_CONFLICT'
  | 'E_BAD_ARGUMENT'
  | 'E_DOCKER'
  | 'E_TIMEOUT'
  | 'E_RESOURCE_OWNERSHIP'
  | 'E_RESOURCE_BUSY';

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: SandboxErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
    this.details = details;
  }
}

export function isSandboxError(value: unknown): value is SandboxError {
  return value instanceof SandboxError;
}
