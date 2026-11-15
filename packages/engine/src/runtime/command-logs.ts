import { randomUUID } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 96 * 1024;
const SESSION_BYTES = 16 * 1024 * 1024;
const SESSION_LOGS = 128;

export interface LogPage {
  data: string;
  offset: number;
  next_offset: number;
  captured_bytes: number;
  total_bytes: number;
  truncated: boolean;
  eof: boolean;
}

/** Bounded host-only command streams. Paths are never accepted from or returned to a model. */
export class CommandLogs {
  private root: string | undefined;
  private entries = new Map<string, { captured: number; total: number }>();
  private retained = 0;
  private closed = false;

  start() {
    if (this.closed) throw new Error('Command logs are closed');
    if (this.entries.size >= SESSION_LOGS) throw new Error('Session command log count exhausted');
    this.root ??= mkdtempSync(join(tmpdir(), 'oms-command-logs-'));
    const id = randomUUID();
    const fd = openSync(join(this.root, id), 'wx', 0o600);
    const entry = { captured: 0, total: 0 };
    this.entries.set(id, entry);
    const head = Buffer.alloc(HEAD_BYTES);
    let headBytes = 0;
    let tail = Buffer.alloc(0);
    let finished = false;
    return {
      id,
      push: (chunk: Buffer) => {
        if (finished || this.closed) throw new Error('Command log is closed');
        const take = Math.min(chunk.length, SESSION_BYTES - this.retained);
        let written = 0;
        while (written < take) written += writeSync(fd, chunk, written, take - written);
        entry.captured += take;
        entry.total += chunk.length;
        this.retained += take;
        const prefix = Math.min(chunk.length, HEAD_BYTES - headBytes);
        chunk.copy(head, headBytes, 0, prefix);
        headBytes += prefix;
        const rest = chunk.subarray(prefix);
        if (rest.length >= TAIL_BYTES) tail = Buffer.from(rest.subarray(-TAIL_BYTES));
        else if (rest.length)
          tail = Buffer.concat([tail.subarray(Math.max(0, tail.length + rest.length - TAIL_BYTES)), rest]);
      },
      finish: () => {
        if (!finished) {
          finished = true;
          closeSync(fd);
        }
        const omitted = entry.total - headBytes - tail.length;
        const marker =
          omitted > 0
            ? Buffer.from(
                `\n[${omitted} bytes omitted; read_log id=${id}; host log ${entry.captured}/${entry.total} bytes]\n`,
              )
            : Buffer.alloc(0);
        return {
          text: Buffer.concat([head.subarray(0, headBytes), marker, tail]).toString('utf8'),
          truncated: omitted > 0 || entry.captured < entry.total,
        };
      },
    };
  }

  /** Arguments are untrusted model input and are validated here. */
  read(id: unknown, offset: unknown = 0, maxBytes: unknown = 16_000): LogPage {
    if (this.closed) throw new Error('Command logs are closed');
    // Only this session's random ids are map keys, so no other string can reach a host path.
    const entry = typeof id === 'string' ? this.entries.get(id) : undefined;
    if (typeof id !== 'string' || !entry || !this.root) throw new Error('Unknown command log id');
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > entry.captured)
      throw new Error('Invalid log offset');
    if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16_000)
      throw new Error('max_bytes must be 1..16000');
    const bytes = Buffer.alloc(Math.min(maxBytes, entry.captured - offset));
    const fd = openSync(join(this.root, id), 'r');
    let count: number;
    try {
      count = readSync(fd, bytes, 0, bytes.length, offset);
    } finally {
      closeSync(fd);
    }
    return {
      data: bytes.subarray(0, count).toString('base64'),
      offset,
      next_offset: offset + count,
      captured_bytes: entry.captured,
      total_bytes: entry.total,
      truncated: entry.captured < entry.total,
      eof: offset + count === entry.captured,
    };
  }

  dispose(): void {
    this.closed = true;
    if (this.root) rmSync(this.root, { recursive: true, force: true });
    this.entries.clear();
  }
}
