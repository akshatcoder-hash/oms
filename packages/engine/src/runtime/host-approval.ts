import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type HostApprovalPolicy = 'deny' | 'allow';
export interface HostApprovalRequest {
  command: string;
  reasons: string[];
}
/** `'session'` allows this exact command for the rest of the session. */
export type HostApprovalAnswer = boolean | 'session';
export type HostApproval = (request: HostApprovalRequest, signal?: AbortSignal) => Promise<HostApprovalAnswer>;

/** How much a chat trusts its commands. The sandbox is the protection where there is one, and YOLO is the user's opt-out. */
export interface HostTrust {
  yolo: boolean;
  /** Commands allowed for the rest of this session. */
  readonly allowed: Set<string>;
}

/** These are disclosures, not a shell security boundary. Host execution is unsandboxed. */
export function hostCommandRisks(command: string, root: string, home = homedir()): string[] {
  const reasons = new Set<string>();
  const expanded = command.replace(/\$\{HOME\}|\$HOME|~(?=\/)/g, home);
  if (/(?:^|[\s;&|])sudo(?:\s|$)/.test(command)) reasons.add('sudo');
  if (/(?:\.ssh|\.aws|\.config\/solana|keychains?|wallet[^\s;|]*|id_rsa|id_ed25519)/i.test(expanded))
    reasons.add('credential or wallet files');
  if (/\b(?:curl|wget)\b[^\n]*\|\s*(?:\/\S*\/)?(?:ba|z|da)?sh\b/.test(command)) reasons.add('download piped to shell');
  const outside = (name: string) => {
    const rel = relative(root, resolve(root, name));
    return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  };
  for (const match of expanded.matchAll(/(?:^|[\s'"=<>])((?:\/|\.\.\/)[^\s'";&|<>]*)/g)) {
    if (outside(match[1]!)) reasons.add('path outside project folder');
  }
  if (/\brm\s+[^\n;]*-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+[^\n;]*-[a-zA-Z]*f[a-zA-Z]*r|\brm\s+[^\n;]*--recursive/.test(command))
    reasons.add('recursive removal');
  if (/(?:>|\b(?:tee|cp|mv|install|mkdir|touch)\b)/.test(command) && reasons.has('path outside project folder'))
    reasons.add('write outside project folder');
  // Shell syntax and arbitrary programs can conceal reads/writes. Approval is
  // required for all model shell invocations, even when no pattern is visible.
  if (!reasons.size) reasons.add('unsandboxed command can access host files and network');
  return [...reasons];
}

export async function approveHostCommand(
  command: string,
  root: string,
  options: {
    policy?: HostApprovalPolicy;
    approve?: HostApproval;
    signal?: AbortSignal;
    allowed?: Set<string>;
  },
): Promise<void> {
  options.signal?.throwIfAborted();
  if (options.allowed?.has(command)) return;
  const request = { command, reasons: hostCommandRisks(command, root) };
  const answer = options.approve ? await options.approve(request, options.signal) : options.policy === 'allow';
  options.signal?.throwIfAborted();
  if (!answer) throw new Error(`Host command denied: ${request.reasons.join(', ')}`);
  if (answer === 'session') options.allowed?.add(command);
}
