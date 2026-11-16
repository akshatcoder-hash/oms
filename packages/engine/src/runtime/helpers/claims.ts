import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Exclusive write claims over path globs, relative to the folder. A helper that edits holds one for its whole life.
 * Acquisition is all-or-nothing and in arrival order, so two helpers can never each hold half of what the other needs.
 */
export interface Claim {
  readonly id: string;
  readonly patterns: readonly string[];
  release(): void;
}

const GLOB_CHARS = /[*?[\]{}]/;

/** Match pi's file-tool spelling before comparing a claim with its destination. */
export function fileToolPath(raw: string): string {
  let path = raw.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ').replace(/^@/, '');
  if (path === '~' || path.startsWith('~/')) path = homedir() + path.slice(1);
  return path.startsWith('file://') ? fileURLToPath(path) : path;
}

/** Claims are folder-relative; absolute spellings are accepted only inside the supplied folder. */
export function normalizePattern(raw: string, folder?: string): string {
  let pattern = fileToolPath(raw.trim()).replaceAll('\\', '/').replace(/^\.\//, '');
  if (folder && isAbsolute(pattern)) pattern = relative(folder, resolve(pattern));
  if (!pattern || pattern.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(pattern))
    throw new Error(`"${raw}" is not a path inside the folder`);
  if (pattern.endsWith('/')) pattern += '**';
  return pattern;
}

function toRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        const slash = pattern[i + 2] === '/';
        source += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** The directory segments before the first glob: two patterns can only overlap when one prefix contains the other. */
function staticPrefix(pattern: string): string[] {
  const segments = pattern.split('/');
  const end = segments.findIndex((segment) => GLOB_CHARS.test(segment));
  return end < 0 ? segments : segments.slice(0, end);
}

const contains = (outer: string[], inner: string[]): boolean =>
  outer.every((segment, index) => inner[index] === segment);

/** Conservative: true when the two pattern sets might name a common file. */
export function patternsOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const left of a.map(staticPrefix))
    for (const right of b.map(staticPrefix)) if (contains(left, right) || contains(right, left)) return true;
  return false;
}

/** Whether a folder-relative path falls under any pattern. A plain name also covers everything below it. */
export function patternsCover(patterns: readonly string[], relPath: string): boolean {
  const path = relPath.replaceAll('\\', '/').replace(/^\.\//, '');
  return patterns.some((pattern) =>
    GLOB_CHARS.test(pattern) ? toRegExp(pattern).test(path) : path === pattern || path.startsWith(`${pattern}/`),
  );
}

interface Waiter {
  id: string;
  patterns: string[];
  grant(): void;
}

interface Held {
  claim: Claim;
  from: number;
  to?: number;
  writes: Map<string, number>;
}

export class ClaimTable {
  private readonly held = new Set<Held>();
  private readonly history: Held[] = [];
  private waiting: Waiter[] = [];

  private readonly folder?: string;

  constructor(folder?: string) {
    this.folder = folder;
  }

  /** Waits for a claim. `onWait` is told once which holder it is waiting for. Rejects when `signal` aborts. */
  async acquire(
    id: string,
    patterns: readonly string[],
    signal: AbortSignal,
    onWait: (holder: string) => void = () => {},
  ): Promise<Claim> {
    const normal = patterns.length ? patterns.map((pattern) => normalizePattern(pattern, this.folder)) : ['**'];
    signal.throwIfAborted();
    const conflict = (before: readonly Waiter[]) =>
      [...this.held].find((entry) => patternsOverlap(entry.claim.patterns, normal))?.claim.id ??
      before.find((entry) => patternsOverlap(entry.patterns, normal))?.id;
    const blocker = conflict(this.waiting);
    if (blocker === undefined) return this.grant(id, normal);
    onWait(blocker);
    return new Promise<Claim>((resolve, reject) => {
      const waiter: Waiter = {
        id,
        patterns: normal,
        grant: () => {
          signal.removeEventListener('abort', abort);
          resolve(this.grant(id, normal));
        },
      };
      const abort = () => {
        this.waiting = this.waiting.filter((entry) => entry !== waiter);
        reject(signal.reason ?? new Error('Cancelled'));
        this.drain();
      };
      signal.addEventListener('abort', abort, { once: true });
      this.waiting.push(waiter);
    });
  }

  covers(claim: Claim, relPath: string): boolean {
    return patternsCover(claim.patterns, relPath);
  }

  recordWrite(claim: Claim, relPath: string): void {
    [...this.held].find((entry) => entry.claim === claim)?.writes.set(relPath, Date.now());
  }

  /** Suppress only observed file-tool writes, never a claim that merely covers the changed path. */
  writtenByOthers(claim: Claim | undefined, relPath: string, since: number): boolean {
    return [...this.history, ...this.held].some(
      (entry) => entry.claim !== claim && (entry.writes.get(relPath) ?? -Infinity) >= since,
    );
  }

  protectedPrefixes(claim: Claim): string[] {
    return [...this.held].flatMap((entry) =>
      entry.claim === claim ? [] : entry.claim.patterns.map((pattern) => staticPrefix(pattern).join('/')),
    );
  }

  private grant(id: string, patterns: string[]): Claim {
    const entry: Held = {
      from: Date.now(),
      writes: new Map(),
      claim: {
        id,
        patterns,
        release: () => {
          if (!this.held.delete(entry)) return;
          entry.to = Date.now();
          this.history.push(entry);
          if (this.history.length > 64) this.history.shift();
          this.drain();
        },
      },
    };
    this.held.add(entry);
    return entry.claim;
  }

  /** A waiter goes when nothing held, and nothing that arrived before it, overlaps its patterns. */
  private drain(): void {
    for (let index = 0; index < this.waiting.length;) {
      const waiter = this.waiting[index]!;
      const blocked =
        [...this.held].some((entry) => patternsOverlap(entry.claim.patterns, waiter.patterns)) ||
        this.waiting.slice(0, index).some((entry) => patternsOverlap(entry.patterns, waiter.patterns));
      if (blocked) index++;
      else {
        this.waiting.splice(index, 1);
        waiter.grant();
      }
    }
  }
}
