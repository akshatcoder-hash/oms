import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Env } from './checks.ts';

const run = promisify(execFile);

export function nodeEnv(cwd: string = process.cwd()): Env {
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    env: process.env,
    async freeDiskGb() {
      const s = await statfs(cwd);
      return (s.bavail * s.bsize) / 1e9;
    },
    async exec(bin, args) {
      try {
        const { stdout, stderr } = await run(bin, args, { timeout: 5000 });
        return { ok: true, out: (stdout || stderr).trim() };
      } catch (e) {
        const err = e as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
        return {
          ok: false,
          out:
            err.code === 'ENOENT'
              ? 'not installed'
              : (err.stderr?.trim() || err.stdout?.trim() || err.message || 'failed')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 300),
        };
      }
    },
    async rpcHealth(url) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
          signal: AbortSignal.timeout(3000),
        });
        const body = (await res.json()) as { result?: unknown };
        return { ok: body.result === 'ok', out: JSON.stringify(body.result) };
      } catch (e) {
        const err = e as { cause?: { code?: string }; name: string };
        return { ok: false, out: `unreachable (${err.cause?.code ?? err.name})` };
      }
    },
  };
}
