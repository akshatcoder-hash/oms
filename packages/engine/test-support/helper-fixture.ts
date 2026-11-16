import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';

type Context = { messages: unknown[] };
type Args = Parameters<typeof fauxToolCall>[1];
export type Step = (context: Context) => AssistantMessage | Promise<AssistantMessage>;

export const say =
  (text: string): Step =>
  () =>
    fauxAssistantMessage(text);
export const call =
  (name: string, args: Args): Step =>
  () =>
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
export const calls =
  (...items: Array<[string, Args]>): Step =>
  () =>
    fauxAssistantMessage(
      items.map(([name, args]) => fauxToolCall(name, args)),
      { stopReason: 'toolUse' },
    );

const text = (value: unknown): string => JSON.stringify(value);

/** A helper's request carries the helper framing in its system prompt. */
export const isHelperRequest = (context: Context): boolean =>
  text(context.messages).includes('You are a helper of another agent');

/** The text of the first user message: the helper's task. */
export function firstTask(context: Context): string {
  const user = context.messages.find((message) => (message as { role?: string }).role === 'user') as
    { content?: unknown } | undefined;
  return text(user?.content ?? '');
}

/**
 * One scripted model for a chat and its helpers. The chat's requests follow `chat` in order. A helper's follow the list whose
 * key appears in its task, one step per request. Each step may wait, so a test controls what overlaps.
 */
export function route(
  chat: Step[],
  helpers: Record<string, Step[]>,
  seen: { tools?: string[][]; tasks?: string[] } = {},
) {
  let chatIndex = 0;
  const counts = new Map<string, number>();
  const router: Step = (context) => {
    if (!isHelperRequest(context)) {
      const step = chat[chatIndex++];
      if (!step) throw new Error('The chat asked for more steps than the test scripted');
      return step(context);
    }
    const task = firstTask(context);
    const key = Object.keys(helpers).find((candidate) => task.includes(candidate));
    if (!key) throw new Error(`No helper script matches: ${task.slice(0, 120)}`);
    const index = counts.get(key) ?? 0;
    counts.set(key, index + 1);
    if (index === 0) seen.tasks?.push(task);
    const step = helpers[key]![index];
    if (!step) throw new Error(`Helper "${key}" asked for more steps than scripted`);
    return step(context);
  };
  return Array.from({ length: 200 }, () => router);
}

/** Resolves when `count` callers have arrived, and holds each until then. Rejects after `ms` so a serial run fails instead of hanging. */
export function barrier(count: number, ms = 8000) {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  return async () => {
    if (++arrived >= count) release();
    await Promise.race([
      open,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`only ${arrived} of ${count} arrived`)), ms).unref(),
      ),
    ]);
  };
}
