import { setImmediate as nextTurn } from 'node:timers/promises';
import xterm from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { Terminal } from '@earendil-works/pi-tui';

export interface Barrier<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
export function barrier<T>(): Barrier<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Public terminal boundary, parsed by a real VT; never contacts a provider. */
export class InterfaceTerminal implements Terminal {
  readonly vt: HeadlessTerminal;
  columns: number;
  rows: number;
  kittyProtocolActive = false;
  active = false;
  drained = false;
  output = '';
  private input?: (data: string) => void;
  private resize?: () => void;
  private pending: Promise<void> = Promise.resolve();
  private revision = 0;
  private readonly writes = new Set<() => void>();
  constructor(columns = 110, rows = 30) {
    this.columns = columns; this.rows = rows;
    this.vt = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 0 });
  }
  start(input: (data: string) => void, resize: () => void): void { this.active = true; this.input = input; this.resize = resize; }
  stop(): void { this.active = false; this.input = undefined; this.resize = undefined; }
  async drainInput(): Promise<void> { this.drained = true; }
  write(data: string): void {
    this.output += data;
    this.pending = this.pending.then(async () => {
      const parsed = barrier<void>();
      this.vt.write(data, () => parsed.resolve());
      await parsed.promise;
      this.revision++;
      for (const listener of this.writes) listener();
    });
  }
  send(data: string): void { this.input?.(data); }
  setSize(columns: number, rows: number): void {
    this.columns = columns; this.rows = rows; this.vt.resize(columns, rows); this.resize?.();
  }
  async screen(): Promise<string> {
    await nextTurn();
    await this.pending;
    return Array.from({ length: this.rows }, (_, row) => this.vt.buffer.active.getLine(row)?.translateToString(true) ?? '').join('\n');
  }
  async until(predicate: (screen: string) => boolean, timeoutMs = 2000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const version = this.revision;
      const screen = await this.screen();
      if (predicate(screen)) return screen;
      if (this.revision !== version) continue;
      const changed = barrier<void>();
      const notify = () => changed.resolve();
      this.writes.add(notify);
      const timeout = setTimeout(() => changed.reject(new Error(`Terminal condition not reached:\n${screen}`)), Math.max(1, deadline - Date.now()));
      try { await changed.promise; } finally { clearTimeout(timeout); this.writes.delete(notify); }
    }
  }
  moveBy(lines: number): void { this.write(lines < 0 ? `\x1b[${-lines}A` : `\x1b[${lines}B`); }
  hideCursor(): void { this.write('\x1b[?25l'); }
  showCursor(): void { this.write('\x1b[?25h'); }
  clearLine(): void { this.write('\x1b[2K'); }
  clearFromCursor(): void { this.write('\x1b[J'); }
  clearScreen(): void { this.write('\x1b[2J\x1b[H'); }
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
}
