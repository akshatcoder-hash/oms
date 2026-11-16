import type { AgentDefinition } from './agents.ts';

/** What the chat's model is told about helpers. It is appended after the locked chat prompt, never inside it. */
export const SUBAGENT_PROMPT = [
  'Helpers: the agent tool hands a task to a helper that works on its own and returns a report.',
  'Use helpers for wide exploration, independent research, changes to files that do not overlap, and review of finished work.',
  'Do not use them for small edits, tightly coupled changes, or anything where your next step depends on the answer.',
  'A helper sees none of this chat, so write a task it can do alone, with the paths and facts it needs.',
  'For an agent that edits, list the files it may change in files; an edit outside them is refused.',
  'To run helpers together, call agent several times in one turn and put no other tool call in that turn. At most 4 run at once.',
  'Read each report and check the result yourself before you tell the user.',
].join('\n');

export function delegationSection(agents: readonly AgentDefinition[]): string {
  const lines = agents.map(
    (agent) => `- ${agent.name} (${agent.tools === 'edit' ? 'edits' : 'read-only'}): ${agent.description}`,
  );
  return `\n\n${SUBAGENT_PROMPT}\nAgents:\n${lines.join('\n')}`;
}
