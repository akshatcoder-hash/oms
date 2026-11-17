export const MAX_DOCUMENT_BYTES = 64 * 1024;
export const MAX_HISTORY_ENTRIES = 128;
const MAX_HISTORY_BYTES = 1024 * 1024;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

interface Selection {
  anchor: number;
  cursor: number;
}
interface Edit {
  start: number;
  removed: string;
  inserted: string;
  before: Selection;
  after: Selection;
  bytes: number;
}

function validateText(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Invalid Unicode surrogate');
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('Invalid Unicode surrogate');
    }
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new RangeError('Document exceeds the 64 KiB UTF-8 limit');
  }
}

/** Exact source text; offsets are UTF-16 indices at grapheme boundaries. */
export class FileDocument {
  private value: string;
  private saved: string;
  private selection: Selection = { anchor: 0, cursor: 0 };
  private boundaries: number[] = [];
  private readonly past: Edit[] = [];
  private readonly future: Edit[] = [];
  private historyBytes = 0;
  readonly newline: string;

  constructor(text: string) {
    validateText(text);
    this.value = text;
    this.saved = text;
    this.newline = /\r\n|\r|\n/.exec(text)?.[0] ?? '\n';
    this.indexGraphemes();
  }

  get text(): string {
    return this.value;
  }
  get dirty(): boolean {
    return this.value !== this.saved;
  }
  get cursor(): number {
    return this.selection.cursor;
  }
  get anchor(): number {
    return this.selection.anchor;
  }
  get selectedText(): string {
    return this.value.slice(Math.min(this.anchor, this.cursor), Math.max(this.anchor, this.cursor));
  }

  markSaved(text: string): void {
    validateText(text);
    this.saved = text;
  }

  select(anchor: number, cursor: number): void {
    if (!this.boundaries.includes(anchor) || !this.boundaries.includes(cursor)) {
      throw new RangeError('Selection must use grapheme boundaries');
    }
    this.selection = { anchor, cursor };
  }

  move(direction: 'left' | 'right', extend = false): void {
    if (!extend && this.anchor !== this.cursor) {
      const cursor = direction === 'left' ? Math.min(this.anchor, this.cursor) : Math.max(this.anchor, this.cursor);
      this.select(cursor, cursor);
      return;
    }
    const index = this.boundaries.indexOf(this.cursor);
    const target = Math.max(0, Math.min(this.boundaries.length - 1, index + (direction === 'left' ? -1 : 1)));
    const cursor = this.boundaries[target]!;
    this.select(extend ? this.anchor : cursor, cursor);
  }

  insert(text: string): void {
    const start = Math.min(this.anchor, this.cursor);
    const end = Math.max(this.anchor, this.cursor);
    const next = this.value.slice(0, start) + text + this.value.slice(end);
    validateText(next);
    if (next === this.value) {
      this.selection = { anchor: end, cursor: end };
      return;
    }
    const removed = this.value.slice(start, end);
    const before = this.selection;
    this.value = next;
    this.indexGraphemes();
    // An insertion can join surrounding combining marks/ZWJ into one grapheme.
    const cursor = this.boundaries.find((offset) => offset >= start + text.length) ?? next.length;
    this.selection = { anchor: cursor, cursor };
    for (const edit of this.future) this.historyBytes -= edit.bytes;
    this.future.length = 0;
    const bytes = Buffer.byteLength(removed, 'utf8') + Buffer.byteLength(text, 'utf8');
    this.past.push({ start, removed, inserted: text, before, after: this.selection, bytes });
    this.historyBytes += bytes;
    while (this.past.length > MAX_HISTORY_ENTRIES || this.historyBytes > MAX_HISTORY_BYTES) {
      this.historyBytes -= this.past.shift()!.bytes;
    }
  }

  backspace(): void {
    this.removeAdjacent('left');
  }

  deleteForward(): void {
    this.removeAdjacent('right');
  }

  undo(): void {
    const edit = this.past.pop();
    if (!edit) return;
    this.value = this.value.slice(0, edit.start) + edit.removed + this.value.slice(edit.start + edit.inserted.length);
    this.selection = edit.before;
    this.indexGraphemes();
    this.future.push(edit);
  }

  redo(): void {
    const edit = this.future.pop();
    if (!edit) return;
    this.value = this.value.slice(0, edit.start) + edit.inserted + this.value.slice(edit.start + edit.removed.length);
    this.selection = edit.after;
    this.indexGraphemes();
    this.past.push(edit);
  }

  private removeAdjacent(direction: 'left' | 'right'): void {
    if (this.anchor !== this.cursor) {
      this.insert('');
      return;
    }
    const before = this.selection;
    this.move(direction, true);
    if (this.anchor === this.cursor) return;
    this.insert('');
    // Undo restores the original caret, not the temporary deletion selection.
    this.past[this.past.length - 1]!.before = before;
  }

  private indexGraphemes(): void {
    this.boundaries = Array.from(segmenter.segment(this.value), (part) => part.index);
    this.boundaries.push(this.value.length);
  }
}
