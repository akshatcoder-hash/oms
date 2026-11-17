/**
 * Thin docker CLI wrappers. Everything goes through execFile with an argv
 * array — no shell interpolation anywhere in oms code.
 */

import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SandboxError } from './errors.ts';

export async function dockerOut(args: string[], timeoutMs = 30_000, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      args,
      {
        timeout: timeoutMs,
        signal,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new SandboxError('E_DOCKER', `docker ${args[0] ?? ''} failed: ${(stderr || stderrOf(err)).trim()}`, {
              args,
              stderr: stderr.trim(),
            }),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export interface CaptureOptions {
  signal: AbortSignal;
  stdout: (chunk: Buffer) => void;
  stderr: (chunk: Buffer) => void;
}

/** Docker is the sole external process boundary; tests supply a stateful daemon double. */
export interface DockerClient {
  out(args: string[], signal?: AbortSignal): Promise<string>;
  capture(args: string[], options: CaptureOptions): Promise<number>;
}

export const sandboxDocker: DockerClient = {
  out: (args, signal) => dockerOut(args, 30_000, signal),
  async capture(args, options) {
    if (options.signal.aborted) return 130;
    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      // The supervisor removes the separately-created owned container before
      // releasing its resource lease; abort only stops this attach client.
      const abort = () => {
        child.kill('SIGKILL');
      };
      options.signal.addEventListener('abort', abort, { once: true });
      let captureError: unknown;
      const deliver = (sink: (chunk: Buffer) => void) => (chunk: Buffer) => {
        if (captureError) return;
        try {
          sink(chunk);
        } catch (error) {
          captureError = error;
          child.kill('SIGKILL');
        }
      };
      child.stdout.on('data', deliver(options.stdout));
      child.stderr.on('data', deliver(options.stderr));
      child.once('error', (error) => {
        reject(new SandboxError('E_DOCKER', `failed to spawn docker: ${error.message}`));
      });
      child.once('close', (code) => {
        options.signal.removeEventListener('abort', abort);
        if (captureError) {
          reject(captureError);
          return;
        }
        resolve(options.signal.aborted ? 130 : (code ?? 127));
      });
      if (options.signal.aborted) abort();
    });
  },
};

function stderrOf(err: unknown): string {
  const e = err as { message?: string; stderr?: string } | null;
  return (e?.stderr || e?.message || 'unknown error').trim();
}

export async function dockerInfoWorks(): Promise<boolean> {
  try {
    await dockerOut(['info', '--format', '{{.ServerVersion}}'], 10_000);
    return true;
  } catch {
    return false;
  }
}

/** Private scratch dir for test fixtures and temp scripts. */
export function makeScratchDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function removeScratchDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
