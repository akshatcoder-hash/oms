/** Serialized bytes assumed per token. Conservative (JSON, code and base64 run 3-4 bytes per token), so a byte budget
 * derived from a token cap errs toward trimming and refusing early rather than overflowing the provider's window. */
export const BYTES_PER_TOKEN = 3;

/** Share of the input cap the messages may fill before trimming starts, and the share trimming brings them back under.
 * The rest of the cap holds what the context hook does not see: the system prompt and tool list (8-10 KB measured), the
 * routing advisory on `oms` routes (up to about 12 KB) and the 12 KB protocol allowance: about 30 KB. The 40% left over
 * covers that from a 25,000-token cap up; below it an `oms` route could overflow (deferred: trim in `context_with_system`
 * against an absolute budget). */
export const CONTEXT_TRIM_START = 0.6;
export const CONTEXT_TRIM_TARGET = 0.4;
/** Newest tool results always sent in full. */
export const CONTEXT_TRIM_KEEP = 2;

const STUB_PREFIX = '[earlier ';
type ContextMessage = { role?: string; toolName?: string; content?: unknown; details?: unknown };
/** Bytes the provider receives: tool-result `details` (pi's read truncation copy, edit diffs) are never sent. */
const bytes = (message: ContextMessage) => Buffer.byteLength(JSON.stringify({ ...message, details: undefined })) + 1;
const isStub = (m: ContextMessage) => Array.isArray(m.content) && m.content.length === 1 &&
  typeof m.content[0]?.text === 'string' && m.content[0].text.startsWith(STUB_PREFIX);

type Block = { type?: string; id?: string; text?: string; textSignature?: unknown };
/** Old assistant reasoning (the encrypted reasoning items replayed on every call, often most of the context) is dropped,
 * and the provider item ids that paired tool calls with it are dropped too (`call|fc_item` becomes `call`), the way the
 * provider adapters replay a different model's messages; text loses its signature id for the same reason. */
const reasoningFree = (m: ContextMessage): boolean => !Array.isArray(m.content) || !(m.content as Block[]).some(b =>
  b.type === 'thinking' || (b.type === 'toolCall' && b.id?.includes('|')) || (b.type === 'text' && b.textSignature !== undefined));
const withoutReasoning = <M extends ContextMessage>(m: M): M => {
  const content = (m.content as Block[]).filter(b => b.type !== 'thinking').map(b =>
    b.type === 'toolCall' && b.id?.includes('|') ? { ...b, id: b.id.split('|')[0] }
      : b.type === 'text' && b.textSignature !== undefined ? { ...b, textSignature: undefined } : b);
  return { ...m, content: content.length ? content : [{ type: 'text', text: '[earlier reasoning removed to fit the context limit]' }] };
};

/**
 * Per session: once the messages pass CONTEXT_TRIM_START of the input cap (tokens, read per call so a model switch moves it),
 * the oldest trimmable messages are shrunk, oldest first, until the messages are under CONTEXT_TRIM_TARGET: a tool result
 * becomes a one-line stub, and an assistant message loses its reasoning. Everything from the CONTEXT_TRIM_KEEP-th newest
 * tool result on is sent in full, and tool calls and their arguments are never changed. No model call is made, so metering
 * is unchanged. The trimmed count only grows, so the prompt prefix stays the same between trims. Results that are already
 * stubs (web_fetch's, which name the URL) are left as they are. Applied per model call only; the session transcript keeps
 * every message.
 */
/** The messages with the given assistant messages' reasoning dropped and the results of their renamed calls renamed to match. */
function stripReasoning<M extends ContextMessage>(messages: M[], indices: Set<number>, shrunk: (m: M) => M): M[] {
  const renamed = new Set([...indices].flatMap(i => messages[i]!.role === 'assistant'
    ? (messages[i]!.content as Block[]).flatMap(b => b.type === 'toolCall' && b.id?.includes('|') ? [b.id] : []) : []));
  return messages.map((m, i) => {
    const sent = indices.has(i) ? shrunk(m) : m;
    const id = (sent as { toolCallId?: string }).toolCallId;
    return sent.role === 'toolResult' && id && renamed.has(id) ? { ...sent, toolCallId: id.split('|')[0] } : sent;
  });
}

export function createContextTrimmer(capTokens: () => number | undefined) {
  let trimmed = 0;
  let forget = false;
  let floor = 0;
  const trimmer = <M extends ContextMessage>(input: M[]): M[] => {
    if (forget) { floor = input.length; forget = false; }
    // Reasoning before the floor is never sent again (see forgetReasoning).
    const forgotten = new Set(input.flatMap((m, i) => i < floor && m.role === 'assistant' && !reasoningFree(m) ? [i] : []));
    const messages = forgotten.size ? stripReasoning(input, forgotten, withoutReasoning) : input;
    const tokens = capTokens();
    if (tokens === undefined) return forgotten.size ? messages : input;
    const capBytes = tokens * BYTES_PER_TOKEN;
    const results = messages.flatMap((m, i) => m.role === 'toolResult' ? [i] : []);
    const cutoff = results.length > CONTEXT_TRIM_KEEP ? results[results.length - CONTEXT_TRIM_KEEP]! : 0;
    const candidates = messages.flatMap((m, i) => i < cutoff && (m.role === 'toolResult' || (m.role === 'assistant' && !reasoningFree(m))) ? [i] : []);
    const stub = (m: M): M => isStub(m) ? m : { ...m, details: undefined, content: [{ type: 'text',
      text: `${STUB_PREFIX}${m.toolName ?? 'tool'} result removed to fit the context limit; run the tool again if you need it]` }] };
    const shrunk = (m: M): M => m.role === 'toolResult' ? stub(m) : withoutReasoning(m);
    const sizes = messages.map(bytes);
    let total = sizes.reduce((a, b) => a + b, 1);
    const shrink = (n: number) => { const i = candidates[n]!; total += bytes(shrunk(messages[i]!)) - sizes[i]!; };
    for (let n = 0; n < Math.min(trimmed, candidates.length); n++) shrink(n);
    if (total > capBytes * CONTEXT_TRIM_START) {
      while (trimmed < candidates.length && total > capBytes * CONTEXT_TRIM_TARGET) shrink(trimmed++);
    }
    if (trimmed === 0) return forgotten.size ? messages : input;
    return stripReasoning(messages, new Set(candidates.slice(0, trimmed)), shrunk);
  };
  /** After the provider rejects a request without saying why, the next call and every later one leave out the reasoning
   * of every message sent so far: a replayed reasoning item the provider no longer accepts is the one part of an
   * otherwise well-formed history it could refuse. Newer messages keep theirs. */
  return Object.assign(trimmer, { forgetReasoning: () => { forget = true; } });
}
