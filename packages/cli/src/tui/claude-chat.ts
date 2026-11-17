import type { OmsSession } from '@oms/engine';

/** Restore display-only native boundaries without inserting them into model context. */
export function nativeChatDisplayHistory(harness: Pick<OmsSession, 'session'>): readonly unknown[] {
  const branch = harness.session.sessionManager.getBranch?.();
  if (!branch?.some((entry) => entry.type === 'custom' && entry.customType === 'oms.claude.native-boundary'))
    return harness.session.messages;
  return branch.flatMap<unknown>((entry) => {
    if (entry.type === 'message') return [entry.message];
    if (entry.type !== 'custom' || entry.customType !== 'oms.claude.native-boundary') return [];
    const data = entry.data as { sessionId?: unknown } | undefined;
    return [
      {
        role: 'session',
        content:
          'Fresh native Claude chat boundary. Previous chat history is not replayed.' +
          (typeof data?.sessionId === 'string' ? ` Native session: ${data.sessionId}` : ''),
      },
    ];
  });
}

/** Report observed transport state; selecting a model or checking login is not a live chat. */
export function claudeChatStatus(harness: OmsSession): string {
  const chat = harness.nativeChat;
  if (!chat) return 'Native Claude chat controls are unavailable in this runtime.';
  const status = chat.status();
  return [
    `Native Claude session: ${status.sessionId ?? 'not started'}`,
    `State: ${status.state}`,
    ...(status.detail ? [status.detail] : []),
    harness.session.model?.provider === 'claude-code'
      ? 'Claude owns this chat history; OMS executes its guarded tools.'
      : 'Claude is not selected. Its chat history is separate from other providers.',
    'Select Claude Code in /model; the next message resumes its saved native history.',
    'With Claude Code selected, /clear starts a fresh native chat and clears the OMS conversation view; your files are retained.',
  ].join('\n');
}
