export const OMS_COMMANDS = [
  { name: 'workbench', group: 'Navigate', description: 'Files and terminal · same agent' },
  { name: 'harness', group: 'Navigate', description: 'Return to the agent conversation' },
  { name: 'files', group: 'Navigate', description: 'Browse task files · Ctrl+P' },
  { name: 'terminal', group: 'Navigate', description: 'Sandbox shell', argument: '[start|stop|hide]' },
  { name: 'help', group: 'Navigate', description: 'Keyboard controls and all commands' },
  { name: 'model', group: 'Setup', description: 'Choose a model in this session', argument: '[search]' },
  { name: 'connect', group: 'Setup', description: 'Provider sign-in or confirmed private file import', argument: '[provider|import <path>]' },
  { name: 'theme', group: 'Setup', description: 'Foreground colors; inherited background', argument: '[name]' },
  { name: 'art', group: 'Setup', description: 'Startup picture', argument: '[next|auto|image|truecolor|256|off]' },
  { name: 'web', group: 'Setup', description: 'Web search, fetch and Solana MCP for this session', argument: '[on|off]' },
  { name: 'settings', group: 'Setup', description: 'Canonical harness preferences and policy limits' },
  { name: 'login', group: 'Setup', description: 'Sign in to OMS (hosted web search) through browser device authorization' },
  { name: 'logout', group: 'Setup', description: 'Revoke OMS access; retain provider credentials and local files' },
  { name: 'account', group: 'Setup', description: 'OMS account status; with an address, a local-chain account', argument: '[address]' },
  { name: 'review', group: 'Inspect', description: 'Offline Phase A security report · no model' },
  { name: 'status', group: 'Inspect', description: 'Requirements, proof and full budget' },
  { name: 'session', group: 'Inspect', description: 'Repository, worktree and session' },
  { name: 'diff', group: 'Inspect', description: 'Task changes against its base; long diffs open in the workbench', argument: '[path]' },
  { name: 'usage', group: 'Inspect', description: 'Tokens, spend, time and the budget caps' },
  { name: 'requirements', group: 'Inspect', description: 'Toggle requirements beside conversation' },
  { name: 'open', group: 'Edit', description: 'Open a task file', argument: '<path>', needsArgument: true },
  { name: 'newfile', group: 'Edit', description: 'New unsaved file · Ctrl+N', argument: '[path]' },
  { name: 'save', group: 'Edit', description: 'Save active file · Ctrl+S' },
  { name: 'close', group: 'Edit', description: 'Close tab; protects unsaved changes · Ctrl+W' },
  { name: 'find', group: 'Edit', description: 'Find text · Ctrl+F' },
  { name: 'replace', group: 'Edit', description: 'Replace text · Ctrl+H' },
  { name: 'next', group: 'Edit', description: 'Next editor tab · Ctrl+Tab' },
  { name: 'split', group: 'Edit', description: 'Toggle second file view · Ctrl+\\ changes side' },
  { name: 'layout', group: 'Navigate', description: 'Workbench conversation panel', argument: '[editor|balanced]' },
  { name: 'verify', group: 'Work', description: 'Independent offline verification', argument: '[item-id]' },
  { name: 'run', group: 'Work', description: 'Run a sandbox command', argument: '<command>', needsArgument: true },
  { name: 'test', group: 'Work', description: 'Run the project tests in the sandbox' },
  { name: 'goal', group: 'Work', description: 'Work until an independent check passes', argument: '[<text> [--check "<command>"] | clear]' },
  { name: 'clear', group: 'Work', description: 'Fresh conversation; task, files and worktree stay' },
  { name: 'cancel', group: 'Work', description: 'Request cancellation of current work' },
  { name: 'quit', group: 'Work', description: 'Close after cleanup; protects dirty files' },
  { name: 'chain', group: 'Solana', description: 'Local Surfpool: RPC, slot, fork state, health' },
  { name: 'rewind', group: 'Solana', description: 'Restore the local chain to its starting state', argument: '[confirm]' },
  { name: 'airdrop', group: 'Solana', description: 'Local-chain SOL airdrop, up to 100', argument: '<address> [sol]', needsArgument: true },
  { name: 'tx', group: 'Solana', description: 'Local-chain transaction: status, error, compute, logs', argument: '<signature>', needsArgument: true },
  { name: 'program', group: 'Solana', description: 'Program reference, offline', argument: '<name|id> [instruction]', needsArgument: true },
  { name: 'error', group: 'Solana', description: 'Decode a custom program error code', argument: '<code> [program]', needsArgument: true },
] as const;

export type OmsCommand = typeof OMS_COMMANDS[number];

/** Only an unfinished command name opens completion; arguments remain normal input. */
export function commandMatches(draft: string): readonly OmsCommand[] | undefined {
  const match = /^\/([a-z]*)$/i.exec(draft.trimStart());
  if (!match) return undefined;
  const query = match[1]!.toLowerCase();
  return OMS_COMMANDS.filter(command => command.name.startsWith(query));
}

export function commandHelp(): string {
  return ['Navigate', 'Setup', 'Edit', 'Inspect', 'Work', 'Solana'].map(group => `${group}\n` +
    OMS_COMMANDS.filter(command => command.group === group).map(command =>
      `/${command.name}${'argument' in command ? ' ' + command.argument : ''} — ${command.description}`)
      // /account is one name for two jobs (OMS account, or with an address a chain account), listed once in the menu under Setup.
      .concat(group === 'Solana' ? ['/account <address> — Local-chain account: owner, lamports, data, token fields'] : []).join('\n')).join('\n\n');
}
