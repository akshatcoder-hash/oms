import { stripTerminalSequences, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

const ENTRY_CHARS = 12_000;
const HISTORY_CHARS = 192_000;
const HISTORY_ENTRIES = 160;

/** All provider, repository, tool and metadata strings cross this boundary before rendering. */
export function displayText(value: string, limit = ENTRY_CHARS): string {
  const clipped = value.length > limit;
  const text = stripTerminalSequences(value.slice(0, limit))
    .replace(/\r\n|\r/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
  return text + (clipped ? '\n[display truncated]' : '');
}

/** Chrome components return physical rows; multiline content belongs only in the editor/transcript. */
export function singleLine(value: string, limit: number): string {
  return displayText(value, limit).replace(/\s+/g, ' ').trim();
}

/** Bounded diagnostic projection; does not invoke toJSON or retain provider objects. */
export function describeValue(value: unknown, depth = 0): string {
  if (typeof value === 'string') return displayText(value, 3000);
  if (value === null || typeof value !== 'object') return String(value);
  if (depth >= 3) return '[…]';
  if (Array.isArray(value))
    return value
      .slice(0, 12)
      .map((item) => describeValue(item, depth + 1))
      .join(', ')
      .slice(0, 4000);
  const parts: string[] = [];
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    parts.push(`${displayText(key, 80)}: ${describeValue((value as Record<string, unknown>)[key], depth + 1)}`);
    if (parts.length === 12) break;
  }
  return parts.join('\n').slice(0, 4000);
}

interface Entry {
  key: string;
  label: string;
  text: string;
  context?: string;
}
function contentText(content: unknown): string {
  if (typeof content === 'string') return displayText(content);
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content.slice(0, 128)) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') text += displayText(block.text) + '\n';
    else if (block.type === 'thinking' && typeof block.thinking === 'string')
      text += 'Reasoning: ' + displayText(block.thinking) + '\n';
    else if (block.type === 'image') text += '[image]\n';
    if (text.length >= ENTRY_CHARS) break;
  }
  return displayText(text.trimEnd());
}

export class Conversation implements Component {
  private readonly entries: Entry[] = [];
  private readonly formatError: (message: string, recordedProvider?: string) => string;
  private sequence = 0;
  private currentMessage: string | undefined;
  private chars = 0;
  private trimmed = false;
  focused = false;

  constructor(
    messages: readonly unknown[],
    formatError: (message: string, recordedProvider?: string) => string = (text) => text,
  ) {
    this.formatError = formatError;
    for (const message of messages.slice(-HISTORY_ENTRIES)) this.message(message, `history-${this.sequence++}`);
    this.trimmed ||= messages.length > HISTORY_ENTRIES;
  }
  invalidate(): void {}

  /** Forget everything shown, for a fresh conversation. */
  clear(): void {
    this.entries.length = 0;
    this.chars = 0;
    this.trimmed = false;
    this.currentMessage = undefined;
  }

  note(label: string, text: string): void {
    this.put({ key: `notice-${this.sequence++}`, label: displayText(label, 100), text: displayText(text) });
  }

  private put(entry: Entry): void {
    const existing = this.entries.findIndex((item) => item.key === entry.key);
    if (existing >= 0) {
      this.chars -= this.entries[existing]!.text.length;
      this.entries[existing] = entry;
    } else this.entries.push(entry);
    this.chars += entry.text.length;
    while (this.entries.length > HISTORY_ENTRIES || this.chars > HISTORY_CHARS) {
      this.chars -= this.entries.shift()!.text.length;
      this.trimmed = true;
    }
  }

  private message(value: unknown, key: string): void {
    if (!value || typeof value !== 'object') return;
    const message = value as {
      role?: string;
      content?: unknown;
      toolCallId?: string;
      toolName?: string;
      provider?: string;
      errorMessage?: string;
      output?: string;
      command?: string;
      exitCode?: number;
    };
    if (message.role === 'toolResult') {
      const previous = this.entries.find((entry) => entry.key === `tool-${message.toolCallId}`);
      this.put({
        key: `tool-${message.toolCallId}`,
        label: previous?.label ?? `tool · ${displayText(message.toolName ?? 'result', 80)}`,
        context: previous?.context,
        text: displayText(`${previous?.context ?? ''}\n${contentText(message.content)}`),
      });
      return;
    }
    if (message.role === 'bashExecution') {
      this.put({
        key,
        label: `sandbox · exit ${message.exitCode ?? 'unknown'}`,
        text: displayText(`${message.command ?? ''}\n${message.output ?? ''}`),
      });
      return;
    }
    const diagnostic = message.errorMessage
      ? displayText(
          message.role === 'assistant'
            ? this.formatError(message.errorMessage, message.provider)
            : message.errorMessage,
          3000,
        )
      : '';
    const text = contentText(message.content);
    // Budget the diagnostic first so a complete streamed/restored body cannot hide its failure.
    // displayText may append its truncation marker; reserve that space inside the entry bound.
    const body = diagnostic
      ? displayText(text, ENTRY_CHARS - diagnostic.length - 1 - '\n[display truncated]'.length)
      : text;
    if (body || diagnostic)
      this.put({
        key,
        label: message.role === 'user' ? 'you' : message.role === 'assistant' ? 'agent' : 'session',
        text: diagnostic ? `${body}\n${diagnostic}` : displayText(body),
      });
  }

  accept(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'message_start':
        this.currentMessage = `message-${this.sequence++}`;
        this.message(event.message, this.currentMessage);
        break;
      case 'message_update':
      case 'message_end':
        this.currentMessage ??= `message-${this.sequence++}`;
        this.message(event.message, this.currentMessage);
        if (event.type === 'message_end') this.currentMessage = undefined;
        break;
      case 'tool_execution_start': {
        const context = describeValue(event.args);
        this.put({
          key: `tool-${event.toolCallId}`,
          label: `tool · ${displayText(event.toolName, 80)} · running`,
          context,
          text: context,
        });
        break;
      }
      case 'tool_execution_update':
        this.put({
          key: `tool-${event.toolCallId}`,
          label: `tool · ${displayText(event.toolName, 80)} · running`,
          context: describeValue(event.args),
          text: displayText(`${describeValue(event.args)}\n${contentText(event.partialResult?.content)}`),
        });
        break;
      case 'tool_execution_end': {
        const previous = this.entries.find((entry) => entry.key === `tool-${event.toolCallId}`);
        const result = contentText(event.result?.content) || describeValue(event.result);
        this.put({
          key: `tool-${event.toolCallId}`,
          label: `tool · ${displayText(event.toolName, 80)} · ${event.isError ? 'failed' : 'finished'}`,
          context: previous?.context,
          text: displayText(`${previous?.context ?? ''}\n${result}`),
        });
        break;
      }
    }
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const lines: string[] = this.trimmed ? ['[earlier display history omitted; session history is retained]'] : [];
    for (const entry of this.entries) {
      lines.push(`\x1b[1m${entry.label}\x1b[0m`);
      lines.push(...wrapTextWithAnsi(entry.text, width), '');
    }
    return lines.slice(-6000);
  }
}
