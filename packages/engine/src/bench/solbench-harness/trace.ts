import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP = new Set(['node_modules', '.git', '.oms-sources']);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

/**
 * Snapshots every text file the agent creates or changes in its workspace, at a fixed interval, so a run can be replayed
 * as the agent's scripts evolved. Content is stored once per hash under files/; index.jsonl records (seconds, path, hash).
 */
export function startWorkspaceTrace(workspace: string, outDir: string, intervalMs = 20_000): () => void {
  const files = join(outDir, 'files');
  mkdirSync(files, { recursive: true });
  const index = join(outDir, 'index.jsonl');
  const seen = new Map<string, string>();
  const started = Date.now();
  let total = 0;
  const walk = (dir: string, out: string[]) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, out);
      else if (entry.isFile()) out.push(path);
    }
  };
  const snap = () => {
    const paths: string[] = [];
    walk(workspace, paths);
    for (const path of paths) {
      let bytes: Buffer;
      try {
        if (statSync(path).size > MAX_FILE_BYTES) continue;
        bytes = readFileSync(path);
      } catch { continue; }
      if (bytes.includes(0)) continue;
      const hash = createHash('sha256').update(bytes).digest('hex');
      const rel = relative(workspace, path);
      if (seen.get(rel) === hash) continue;
      seen.set(rel, hash);
      const stored = join(files, hash);
      if (!existsSync(stored)) {
        if (total + bytes.length > MAX_TOTAL_BYTES) continue;
        total += bytes.length;
        copyFileSync(path, stored);
      }
      appendFileSync(index, JSON.stringify({ t: Math.round((Date.now() - started) / 1000), path: rel, bytes: bytes.length, sha256: hash }) + '\n');
    }
  };
  snap();
  const timer = setInterval(snap, intervalMs);
  return () => { clearInterval(timer); snap(); };
}

/** The egress proxy's host log, cut to one run's time window (hosts only: traffic is TLS). Shared when runs overlap in time. */
export function sliceEgressLog(egressLog: string, fromMs: number, toMs: number, out: string): void {
  let text: string;
  try { text = readFileSync(egressLog, 'utf8'); } catch { return; }
  const lines = text.split('\n').filter(line => {
    if (!line) return false;
    try { const at = Date.parse((JSON.parse(line) as { at?: string }).at ?? ''); return at >= fromMs && at <= toMs; } catch { return false; }
  });
  appendFileSync(out, lines.join('\n') + (lines.length ? '\n' : ''));
}
