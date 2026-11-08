import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from './normalize.ts';
import { parseLesson, type Lesson } from './types.ts';
export function repoKey(root: string): string { return sha256(realpathSync(root)).slice(0, 16); }
export function memoryPath(home: string, root?: string): string { return join(home, '.oms', 'memory', root ? repoKey(root) : '_user', 'lessons.jsonl'); }
export function readLessons(path: string): Lesson[] {
  try { return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => parseLesson(JSON.parse(line))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
const encode = (rows: Lesson[]): string => rows.map(row => JSON.stringify(row) + '\n').join('');
export function capLessons(rows: Lesson[], now: number): Lesson[] {
  const cutoff = now - 180 * 86400_000;
  const order = (row: Lesson): number => row.tier === 'retired' ? 0 : row.evidence.every(evidence => Date.parse(evidence.at) < cutoff) ? 1 : 2;
  const kept = [...rows].sort((a, b) => order(a) - order(b) || Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  while (kept.length > 500 || Buffer.byteLength(encode(kept)) > 1_000_000) kept.shift();
  return kept;
}
/** Root containment is resolved before creating the store; writes are host-only. */
export function updateLessons(path: string, workspace: string, update: (rows: Lesson[]) => Lesson[], now = Date.now()): Lesson[] {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const target = join(realpathSync(dirname(path)), path.split(/[\\/]/).at(-1)!);
  const rel = relative(realpathSync(workspace), target);
  if (rel === '' || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel))) throw new Error('Memory must be outside workspace');
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const rows = capLessons(update(readLessons(target)).map(parseLesson), now);
    writeFileSync(temporary, encode(rows), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
    return rows;
  } finally { rmSync(temporary, { force: true }); }
}
