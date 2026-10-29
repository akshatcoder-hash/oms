/**
 * Cache prefix segments.
 *
 * Policy: docs/knowledge-and-cache.md section 2 (canonical prefix) and section 8
 * (cache-breaking attribution). The prefix is a set of named blocks; each block is
 * hashed independently so a break can be attributed to a named segment, which the
 * doc requires ("names the segment that broke the cache").
 *
 * Byte-stability is a rule, not a preference: the prefix may not contain timestamps,
 * UUIDs, request/session ids, pids, directory listings or machine-specific absolute
 * paths (doc section 1.1). `scanPrefixBlocks` is the enforcement half of that rule.
 */

import { createHash } from 'node:crypto';

/** Named prefix/transcript segments, in canonical order. */
export type SegmentName =
  | 'system'
  | 'tool_schemas'
  | 'skill_index'
  | 'pinned_notes'
  | 'epoch_head'
  | 'dynamic_tail';

export const SEGMENT_ORDER: readonly SegmentName[] = Object.freeze([
  'system',
  'tool_schemas',
  'skill_index',
  'pinned_notes',
  'epoch_head',
  'dynamic_tail',
]);

/**
 * Segments that form the cacheable prefix. `epoch_head` and `dynamic_tail` are
 * tracked for attribution but are transcript content, not prefix content.
 */
export const PREFIX_SEGMENTS: readonly SegmentName[] = Object.freeze([
  'system',
  'tool_schemas',
  'skill_index',
  'pinned_notes',
]);

export interface SegmentHash {
  readonly name: SegmentName;
  readonly hash: string;
  /** Canonical byte length of the segment content, for meter display. */
  readonly bytes: number;
}

export type SegmentBlocks = Partial<Record<SegmentName, string>>;
export type SegmentHashMap = Partial<Record<SegmentName, string>>;

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Canonical text form: LF newlines, no trailing whitespace on any line, no
 * trailing blank lines. Key ordering is the caller's job (tool schemas must be
 * serialized with sorted keys before they reach here).
 */
export function canonicalizeSegmentText(text: string): string {
  const unified = text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '');
  return unified.replace(/\n+$/, '');
}

export function hashSegment(name: SegmentName, content: string): SegmentHash {
  const canonical = canonicalizeSegmentText(content);
  return {
    name,
    hash: sha256Hex(canonical),
    bytes: Buffer.byteLength(canonical, 'utf8'),
  };
}

/** Hash every present block, in `SEGMENT_ORDER`. Absent blocks are omitted. */
export function buildSegmentHashes(blocks: SegmentBlocks): SegmentHash[] {
  const out: SegmentHash[] = [];
  for (const name of SEGMENT_ORDER) {
    const content = blocks[name];
    if (content === undefined) continue;
    out.push(hashSegment(name, content));
  }
  return out;
}

export function segmentHashMap(segments: readonly SegmentHash[]): SegmentHashMap {
  const out: SegmentHashMap = {};
  for (const segment of segments) out[segment.name] = segment.hash;
  return out;
}

/**
 * `prefix_bytes = concat(instructions_block, tool_schemas_block, index_block)`
 * (doc section 2), so the prefix hash covers only `PREFIX_SEGMENTS`, joined in
 * canonical order with the segment name included so a hash cannot silently move
 * between segments.
 */
export function prefixHash(segments: readonly SegmentHash[]): string {
  const byName = segmentHashMap(segments);
  const parts: string[] = [];
  for (const name of PREFIX_SEGMENTS) {
    const hash = byName[name];
    if (hash !== undefined) parts.push(`${name}:${hash}`);
  }
  return sha256Hex(parts.join('\n'));
}

export interface SegmentBust {
  readonly busted: true;
  /** First segment, in `SEGMENT_ORDER`, whose hash changed. */
  readonly segment: SegmentName;
  readonly index: number;
  readonly previousHash: string | null;
  readonly nextHash: string | null;
}

export interface NoBust {
  readonly busted: false;
  readonly segment: null;
  readonly index: -1;
  readonly previousHash: null;
  readonly nextHash: null;
}

export type BustResult = SegmentBust | NoBust;

/** A segment that exists on one side only counts as changed at that position. */
export function detectBust(
  previous: SegmentHashMap,
  next: SegmentHashMap,
): BustResult {
  for (let index = 0; index < SEGMENT_ORDER.length; index += 1) {
    const name = SEGMENT_ORDER[index];
    if (name === undefined) continue;
    const before = previous[name] ?? null;
    const after = next[name] ?? null;
    if (before !== after) {
      return { busted: true, segment: name, index, previousHash: before, nextHash: after };
    }
  }
  return { busted: false, segment: null, index: -1, previousHash: null, nextHash: null };
}

export type ForbiddenRule =
  | 'timestamp'
  | 'uuid'
  | 'directory_listing'
  | 'absolute_path'
  | 'request_id'
  | 'session_id'
  | 'process_id';

export interface ForbiddenMatch {
  readonly rule: ForbiddenRule;
  /** UTF-16 offset in the scanned text. */
  readonly index: number;
  /** Short, whitespace-collapsed excerpt around the match. */
  readonly excerpt: string;
}

export interface PrefixForbiddenMatch extends ForbiddenMatch {
  readonly segment: SegmentName;
}

interface ForbiddenPattern {
  readonly rule: ForbiddenRule;
  readonly pattern: RegExp;
}

const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = Object.freeze([
  // ISO-8601 date+time, with or without zone/seconds.
  { rule: 'timestamp', pattern: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g },
  // Bare calendar date.
  { rule: 'timestamp', pattern: /\b\d{4}-\d{2}-\d{2}\b/g },
  // Epoch milliseconds.
  { rule: 'timestamp', pattern: /\b(?:1[6-9]\d{11}|2\d{12})\b/g },
  { rule: 'uuid', pattern: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g },
  // `ls -l` style listing rows and totals.
  { rule: 'directory_listing', pattern: /^total \d+$/gm },
  { rule: 'directory_listing', pattern: /^[bcdlps-][rwxsStT-]{9}[@+.]?[ \t]+\d/gm },
  // Machine-specific absolute paths.
  { rule: 'absolute_path', pattern: /(?:^|[\s"'(=])\/(?:Users|home|private|tmp|var|opt|root|mnt)\/[^\s"'`)]+/g },
  { rule: 'absolute_path', pattern: /\b[A-Za-z]:\\[^\s"']+/g },
  { rule: 'request_id', pattern: /\b(?:req|request)[_-]?id\b\s*[:=]\s*["']?[A-Za-z0-9_-]{6,}/gi },
  { rule: 'session_id', pattern: /\b(?:session|thread|conversation)[_-]?id\b\s*[:=]\s*["']?[A-Za-z0-9_-]{6,}/gi },
  { rule: 'process_id', pattern: /\bpid\b\s*[:=]\s*\d+/gi },
]);

function excerptAt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 12);
  const end = Math.min(text.length, index + length + 12);
  const raw = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return raw.length > 72 ? `${raw.slice(0, 69)}...` : raw;
}

/** All forbidden-content hits in one block, ordered by offset then rule name. */
export function scanForbiddenText(text: string): ForbiddenMatch[] {
  const accepted: Array<{ rule: ForbiddenRule; index: number; end: number; excerpt: string }> = [];
  for (const { rule, pattern } of FORBIDDEN_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      const end = index + match[0].length;
      if (match[0].length === 0) continue;
      // Overlapping hits (a bare date inside an ISO timestamp) are one finding.
      if (accepted.some((hit) => index < hit.end && end > hit.index)) continue;
      accepted.push({ rule, index, end, excerpt: excerptAt(text, index, match[0].length) });
    }
  }
  accepted.sort((a, b) => (a.index !== b.index ? a.index - b.index : ruleOrder(a.rule, b.rule)));
  return accepted.map((hit) => ({ rule: hit.rule, index: hit.index, excerpt: hit.excerpt }));
}

function ruleOrder(a: ForbiddenRule, b: ForbiddenRule): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Forbidden-content scan restricted to the cacheable prefix blocks. */
export function scanPrefixBlocks(blocks: SegmentBlocks): PrefixForbiddenMatch[] {
  const out: PrefixForbiddenMatch[] = [];
  for (const segment of PREFIX_SEGMENTS) {
    const text = blocks[segment];
    if (text === undefined) continue;
    for (const hit of scanForbiddenText(text)) out.push({ ...hit, segment });
  }
  return out;
}

/** Convenience predicate for a guard that must fail closed. */
export function isPrefixStable(blocks: SegmentBlocks): boolean {
  return scanPrefixBlocks(blocks).length === 0;
}
