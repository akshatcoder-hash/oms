/**
 * Append-only JSONL trace.
 *
 * One JSON object per line, appended with `writeSync`. The writer never throws at
 * the caller: every failure comes back as a result value, because trace failures
 * must not take down a turn. A crash during a write leaves a torn last line, which
 * `parseTrace` reports instead of throwing (strict, recoverable reader).
 *
 * Redaction runs on every event before serialization, so the trace file is the
 * single place a secret could otherwise land in plaintext.
 */

import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';

const TRACE_EVENT_TYPES = Object.freeze(['turn', 'tool_call', 'tool_result', 'settle', 'budget'] as const);

export type TraceEventType = (typeof TRACE_EVENT_TYPES)[number];

export interface TraceEvent {
  readonly seq: number;
  /** ISO-8601, from the injected clock. */
  readonly time: string;
  readonly type: TraceEventType;
  readonly [key: string]: unknown;
}

export type TraceEventInput = { readonly type: TraceEventType } & Record<string, unknown>;

export type TraceRedactor = (event: TraceEvent) => TraceEvent;

export type TraceErrorCode = 'E_OPEN' | 'E_CLOSED' | 'E_CLOCK' | 'E_REDACT' | 'E_SERIALIZE' | 'E_WRITE';

export interface TraceWriteOk {
  readonly ok: true;
  readonly seq: number;
}

export interface TraceWriteError {
  readonly ok: false;
  readonly code: TraceErrorCode;
  readonly message: string;
}

export type TraceWriteResult = TraceWriteOk | TraceWriteError;

export type TraceCloseResult = { readonly ok: true } | TraceWriteError;

export interface TraceWriterOptions {
  readonly path: string;
  /** Milliseconds since epoch. Injected so tests and replays are deterministic. */
  readonly clock: () => number;
  readonly redact?: TraceRedactor;
  /** Flush each record to disk. Slower; off by default. */
  readonly fsync?: boolean;
}

export interface TraceWriter {
  append(event: TraceEventInput): TraceWriteResult;
  close(): TraceCloseResult;
  /** Next sequence number that will be written (1-based). */
  readonly nextSeq: number;
  readonly path: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTraceEventType(value: unknown): value is TraceEventType {
  return typeof value === 'string' && (TRACE_EVENT_TYPES as readonly string[]).includes(value);
}

export function createTraceWriter(options: TraceWriterOptions): TraceWriter {
  let fd: number | null = null;
  let openError: string | null = null;
  let closed = false;
  let writeError: string | null = null;
  let nextSeq = 1;
  try {
    fd = openSync(options.path, 'a+', 0o600);
    const existing = parseTrace(readFileSync(fd, 'utf8'));
    if (existing.issues.length > 0 || existing.tornLastLine !== null) {
      throw new Error('trace append refused: existing trace is corrupt or has an unterminated tail; preserve and recover it explicitly');
    }
    nextSeq = (existing.events.at(-1)?.seq ?? 0) + 1;
    if (!Number.isSafeInteger(nextSeq)) throw new Error('trace sequence exhausted');
  } catch (error) {
    openError = errorMessage(error);
    if (fd !== null) {
      try { closeSync(fd); } catch { /* Preserve the original open/recovery failure. */ }
      fd = null;
    }
  }

  const append = (input: TraceEventInput): TraceWriteResult => {
    if (closed) return { ok: false, code: 'E_CLOSED', message: 'trace writer is closed' };
    if (writeError !== null) return { ok: false, code: 'E_WRITE', message: writeError };
    if (fd === null) {
      return { ok: false, code: 'E_OPEN', message: openError ?? 'trace file is not open' };
    }
    if (input === null || typeof input !== 'object' || !isTraceEventType(input.type)) {
      return { ok: false, code: 'E_REDACT', message: 'trace event must be an object with a known type' };
    }

    let time: string;
    try {
      const now = options.clock();
      if (!Number.isFinite(now)) throw new Error(`clock returned ${String(now)}`);
      time = new Date(now).toISOString();
    } catch (error) {
      return { ok: false, code: 'E_CLOCK', message: errorMessage(error) };
    }

    const event: TraceEvent = { ...input, seq: nextSeq, time };

    let redacted: TraceEvent;
    if (options.redact !== undefined) {
      try {
        redacted = options.redact(event);
      } catch (error) {
        return { ok: false, code: 'E_REDACT', message: errorMessage(error) };
      }
      if (redacted === null || typeof redacted !== 'object' || Array.isArray(redacted)) {
        return { ok: false, code: 'E_REDACT', message: 'redact() must return an event object' };
      }
    } else {
      redacted = event;
    }
    if (validateLine(redacted, nextSeq) !== null || redacted.time !== time || redacted.type !== input.type) {
      return { ok: false, code: 'E_REDACT', message: 'redactor changed trace metadata' };
    }

    let line: string;
    try {
      line = JSON.stringify(redacted);
    } catch (error) {
      return { ok: false, code: 'E_SERIALIZE', message: errorMessage(error) };
    }
    if (typeof line !== 'string') {
      return { ok: false, code: 'E_SERIALIZE', message: 'event serialized to a non-string' };
    }

    const buffer = Buffer.from(`${line}\n`, 'utf8');
    try {
      const written = writeSync(fd, buffer);
      if (written !== buffer.length) {
        writeError = `short write: ${written}/${buffer.length} bytes (torn line); writer disabled`;
        return { ok: false, code: 'E_WRITE', message: writeError };
      }
      if (options.fsync === true) fsyncSync(fd);
    } catch (error) {
      writeError = `trace write outcome uncertain; writer disabled: ${errorMessage(error)}`;
      return { ok: false, code: 'E_WRITE', message: writeError };
    }

    const seq = nextSeq;
    nextSeq += 1;
    return { ok: true, seq };
  };

  const close = (): TraceCloseResult => {
    closed = true;
    if (fd === null) return { ok: true };
    const handle = fd;
    fd = null;
    try {
      closeSync(handle);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'E_CLOSED', message: errorMessage(error) };
    }
  };

  return {
    append,
    close,
    get nextSeq(): number {
      return nextSeq;
    },
    path: options.path,
  };
}

export type TraceIssueCode =
  | 'invalid_json'
  | 'not_object'
  | 'bad_seq'
  | 'bad_time'
  | 'bad_type'
  | 'read_error';

export interface TraceIssue {
  /** 1-based line number; 0 for a file-level read error. */
  readonly line: number;
  readonly code: TraceIssueCode;
  readonly text: string;
}

export interface TraceParseResult {
  readonly events: TraceEvent[];
  readonly issues: TraceIssue[];
  /** Final line without its newline commit marker, even if valid JSON. Not an issue. */
  readonly tornLastLine: string | null;
  readonly lineCount: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateLine(value: unknown, expectedSeq: number): TraceIssueCode | null {
  if (!isPlainObject(value)) return 'not_object';
  if (value.seq !== expectedSeq) return 'bad_seq';
  if (typeof value.time !== 'string' || Number.isNaN(Date.parse(value.time))) return 'bad_time';
  if (!isTraceEventType(value.type)) return 'bad_type';
  return null;
}

/**
 * Parse JSONL strictly: sequence must start at 1 and increase by one, every record
 * must have a known type and a parseable ISO time. Bad middle lines are reported and
 * skipped; an incomplete final line becomes `tornLastLine`.
 */
export function parseTrace(text: string): TraceParseResult {
  const events: TraceEvent[] = [];
  const issues: TraceIssue[] = [];
  let tornLastLine: string | null = null;

  if (text.length === 0) return { events, issues, tornLastLine, lineCount: 0 };

  const endsWithNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (endsWithNewline) lines.pop();

  let expectedSeq = 1;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const lineNumber = i + 1;
    if (!endsWithNewline && i === lines.length - 1) {
      tornLastLine = raw;
      break;
    }
    if (raw.length === 0) {
      issues.push({ line: lineNumber, code: 'invalid_json', text: raw });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      issues.push({ line: lineNumber, code: 'invalid_json', text: raw });
      continue;
    }

    const problem = validateLine(parsed, expectedSeq);
    if (problem !== null) {
      issues.push({ line: lineNumber, code: problem, text: raw });
      if (problem === 'bad_seq' && isPlainObject(parsed) && typeof parsed.seq === 'number') {
        expectedSeq = parsed.seq + 1;
      }
      continue;
    }

    const event = parsed as TraceEvent;
    events.push(event);
    expectedSeq = event.seq + 1;
  }

  return { events, issues, tornLastLine, lineCount: lines.length };
}

/** Read and parse a trace file. A missing file is an issue, never a throw. */
export function readTraceFile(path: string): TraceParseResult {
  try {
    return parseTrace(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      events: [],
      issues: [{ line: 0, code: 'read_error', text: errorMessage(error) }],
      tornLastLine: null,
      lineCount: 0,
    };
  }
}

export interface ReplayOptions {
  readonly types?: readonly TraceEventType[];
}

/** Iterate the readable prefix of a trace, optionally filtered by event type. */
export function* replayTrace(
  result: TraceParseResult,
  options: ReplayOptions = {},
): Generator<TraceEvent> {
  const types = options.types;
  for (const event of result.events) {
    if (types !== undefined && !types.includes(event.type)) continue;
    yield event;
  }
}
