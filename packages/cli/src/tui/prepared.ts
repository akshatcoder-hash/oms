/** What a slash command shows: a conversation note, plus optionally the full text for a read-only workbench report. */
export interface CommandOutput {
  title: string;
  text: string;
  report?: { id: string; text: string };
  /** The note is shown, then the action fails with this message and the draft is retained. */
  failure?: string;
  /** Show the note without moving to the agent conversation: the view and focus stay where they are. */
  inPlace?: true;
  /** Clear the notice row once the note is shown. */
  clearNotice?: true;
  /** Once the command's own work has ended, send this to the agent as the person's next message (/pr, /issue, /ci). */
  ask?: string;
}
/**
 * A parsed command: either a refusal for the notice row, or the work to run. The work returns nothing when it has nothing to
 * show. The refusal reads "<message> Draft retained." unless the message is already a complete notice.
 */
export type Prepared =
  | { ok: true; run(signal: AbortSignal): Promise<CommandOutput | undefined> }
  | { ok: false; message: string; complete?: true };
export const refuse = (message: string): Prepared => ({ ok: false, message });
/** A refusal whose message is the whole notice. */
export const refuseWith = (message: string): Prepared => ({ ok: false, message, complete: true });

/** The workbench editor holds 64 KiB; a preview stays under it. */
export const REPORT_BYTES = 60 * 1024;

/** The first `limit` bytes of `text` without splitting a character; a cut preview ends with `marker`. */
export function previewBytes(text: string, limit: number, marker = '\n[Preview truncated.]'): string {
  let bytes = 0;
  let preview = '';
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > limit) return preview + marker;
    preview += character;
  }
  return preview;
}
