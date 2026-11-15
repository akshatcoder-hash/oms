/**
 * Output boundary.
 *
 * Everything the signer writes - log lines, trace records, socket responses -
 * goes through `SecretMaterial.scrub` exactly once, at the point of writing.
 * That keeps the guarantee in one place instead of scattered across call sites.
 */

import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeJson, type SecretMaterial } from './secret.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
  lines(): readonly string[];
}

export interface Trace {
  record(event: Record<string, unknown>): void;
  lines(): readonly string[];
}

export interface FileSinkOptions {
  path: string;
  /** File mode for the sink; 0600 by default. */
  mode?: number;
}

function createFileSink(options: FileSinkOptions): (line: string) => void {
  const mode = options.mode ?? 0o600;
  try {
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    writeFileSync(options.path, '', { mode });
    chmodSync(options.path, mode);
  } catch {
    // Fall through to append; a broken sink must not take the signer down.
  }
  return (line: string): void => {
    try {
      appendFileSync(options.path, line + '\n', { mode });
    } catch {
      // Best effort: losing a log line is better than crashing a signer.
    }
  };
}

export interface CreateLoggerOptions {
  secret: SecretMaterial;
  filePath?: string;
  /** Additional sink, e.g. process.stdout for the CLI. */
  alsoWrite?: (line: string) => void;
  capture?: boolean;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const fileSink = options.filePath ? createFileSink({ path: options.filePath }) : null;
  const captured: string[] = [];
  const capture = options.capture ?? true;

  return {
    lines(): readonly string[] {
      return captured;
    },
    log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
      const payload = safeJson({ ts: new Date().toISOString(), level, event, ...fields }, options.secret);
      if (capture) captured.push(payload);
      fileSink?.(payload);
      options.alsoWrite?.(payload);
    },
  };
}

export interface CreateTraceOptions {
  secret: SecretMaterial;
  filePath?: string;
  capture?: boolean;
}

export function createTrace(options: CreateTraceOptions): Trace {
  const fileSink = options.filePath ? createFileSink({ path: options.filePath }) : null;
  const captured: string[] = [];
  const capture = options.capture ?? true;

  return {
    lines(): readonly string[] {
      return captured;
    },
    record(event: Record<string, unknown>): void {
      const payload = safeJson({ ts: new Date().toISOString(), ...event }, options.secret);
      if (capture) captured.push(payload);
      fileSink?.(payload);
    },
  };
}

/** A no-op logger/trace for unit tests that only care about responses. */
export function nullSink(): void {
  return;
}
