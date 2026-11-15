/**
 * Tool-call guards for the generator agent.
 *
 * Three rules, all fail-closed:
 *
 * 1. Path allowlist. A write to a digest-pinned file (verifier tests, `.oms/task.json`,
 *    evaluator config) is refused, and a read or a write under a denied root (signer
 *    directory, Solana CLI config, `~/.ssh`, oms state) is refused. Every path is
 *    resolved through `realpath` on its deepest existing ancestor first, so a symlink,
 *    a `..` segment or a `~` prefix cannot walk around the rule.
 * 2. Repetition guard. The same tool with the same canonical input N times inside
 *    a sliding window is blocked, so a stuck loop costs one call instead of a turn.
 * 3. Diff-size guard. One call may not carry more than `maxEditBytes` of new text.
 *
 * For `bash`/`powershell` the path rule is a text scan and is best effort by
 * construction: a command can build a path at runtime (`p=~/.ss; cat ${p}h/id`). The
 * sandbox is the real control. This hook only keeps the
 * obvious forms from reaching a shell at all.
 *
 * Path containment and symlink-safe resolution (`isInside`, `realpathAllowingMissing`) come from `@oms/contract`,
 * so the guards and the contract resolve paths with one implementation.
 */

import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { isInside, realpathAllowingMissing } from '@oms/contract';

const DEFAULT_MAX_EDIT_BYTES = 64 * 1024;
const DEFAULT_REPETITION_THRESHOLD = 3;
const DEFAULT_REPETITION_WINDOW = 12;

export type GuardBlockRule = 'protected_write' | 'denied_root' | 'repetition' | 'diff_size' | 'guard_error';

export type GuardDecision =
  | { readonly block: false }
  | { readonly block: true; readonly rule: GuardBlockRule; readonly reason: string };

/** The part of a Pi `tool_call` event the guards need; kept Pi-free so it is unit-testable. */
export interface GuardedToolCall {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

export interface RepetitionConfig {
  /** How many identical calls are allowed before the next one is blocked. */
  readonly threshold?: number;
  /** How many previous calls are considered. */
  readonly window?: number;
}

export interface GuardsConfig {
  /** Digest-pinned files or directories. Writes are refused; reads are allowed. */
  readonly protectedPaths?: readonly string[];
  /** Key material and signer/oms state. Reads and writes are refused. */
  readonly deniedRoots?: readonly string[];
  /** Host shell access is mediated by an approval callback instead. */
  readonly approveHostCommands?: boolean;
  readonly repetition?: RepetitionConfig;
  readonly maxEditBytes?: number;
  /** Base for relative paths. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

/** One already-decided call, kept so a repeat can be recognised. */
export interface ToolCallSample {
  readonly key: string;
}

export type GuardHistory = readonly ToolCallSample[];

const ALLOW: GuardDecision = Object.freeze({ block: false });

function block(rule: GuardBlockRule, detail: string): GuardDecision {
  // The rule id is part of the model-visible text: the transcript is the audit log,
  // so a block must say which rule fired, not only what looked wrong.
  return { block: true, rule, reason: `blocked (${rule}): ${detail}` };
}

const PATH_TOOL_SPECS: Record<string, { readonly access: 'read' | 'write'; readonly field: string }> = {
  read: { access: 'read', field: 'path' },
  write: { access: 'write', field: 'path' },
  edit: { access: 'write', field: 'path' },
  grep: { access: 'read', field: 'path' },
  find: { access: 'read', field: 'path' },
  ls: { access: 'read', field: 'path' },
};

const REQUIRED_PATH_TOOLS = new Set(['read', 'write', 'edit']);
const COMMAND_TOOLS = new Set(['bash', 'powershell']);

function realpathOfNearest(p: string): string {
  try {
    const resolved = realpathAllowingMissing(p);
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  } catch {
    return p;
  }
}

/** Case-folded variant covers case-insensitive volumes. */
function pathVariants(p: string): readonly string[] {
  return [p, p.toLowerCase()];
}

// --- resolution -------------------------------------------------------------------

interface ResolvedPath {
  readonly raw: string;
  readonly absolute: string;
  readonly real: string;
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith(`~${sep}`)) return join(home, p.slice(2));
  return p;
}

function resolvePath(requested: string, cwd: string, home: string): ResolvedPath {
  const expanded = expandHome(requested, home);
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  let real = realpathOfNearest(absolute);
  try {
    // If the target itself exists, its true realpath is the only trustworthy answer.
    statSync(real);
    real = realpathSync(real);
  } catch {
    // Does not exist yet: the ancestor-resolved path stands.
  }
  return { raw: requested, absolute, real };
}

function candidatesOf(path: ResolvedPath): readonly string[] {
  return [...pathVariants(path.absolute), ...pathVariants(path.real)];
}

function matchesTarget(candidates: readonly string[], target: ResolvedPath): boolean {
  for (const entry of [...pathVariants(target.absolute), ...pathVariants(target.real)]) {
    for (const candidate of candidates) {
      if (isInside(entry, candidate)) return true;
    }
  }
  return false;
}

interface CommandNeedle {
  readonly needle: string;
  readonly rule: GuardBlockRule;
}

interface PreparedTargets {
  readonly protectedTargets: readonly ResolvedPath[];
  readonly deniedTargets: readonly ResolvedPath[];
  /** Lowercased strings whose presence in a shell command blocks it. */
  readonly commandNeedles: readonly CommandNeedle[];
}

function prepareTargets(config: GuardsConfig, cwd: string, home: string): PreparedTargets {
  const protectedTargets = (config.protectedPaths ?? []).map((entry) => resolvePath(entry, cwd, home));
  const deniedTargets = (config.deniedRoots ?? []).map((entry) => resolvePath(entry, cwd, home));

  const needles = new Map<string, GuardBlockRule>();
  const addNeedle = (value: string, rule: GuardBlockRule): void => {
    const needle = value.trim().toLowerCase();
    // Anything shorter than three characters matches ordinary command text by accident.
    if (needle.length < 3) return;
    // A denied root wins when both lists produce the same needle.
    if (needles.get(needle) === 'denied_root') return;
    needles.set(needle, rule);
  };
  // Folder names on the task's own path (host worktrees live under `.oms`) never become short needles.
  const ownSegments = new Set(resolve(cwd).split(sep));
  const addTarget = (target: ResolvedPath, rule: GuardBlockRule, shortName = true): void => {
    addNeedle(target.raw, rule);
    addNeedle(expandHome(target.raw, home), rule);
    addNeedle(target.absolute, rule);
    addNeedle(target.real, rule);
    // `~/.ssh`, `$HOME/.ssh` and `${HOME}/.ssh` name the same place as the absolute path.
    if (target.absolute.startsWith(`${home}${sep}`)) {
      const rel = target.absolute.slice(home.length + 1);
      for (const prefix of ['~', '$HOME', '${HOME}', '"$HOME"', '"${HOME}"']) addNeedle(`${prefix}${sep}${rel}`, rule);
    }
    // A distinctive tail (`/.ssh`, `/.config/solana`) still matches when the command
    // walks to the target with `cd` plus `..` instead of writing the full path.
    if (!isAbsolute(expandHome(target.raw, home))) return;
    const parts = target.absolute.split(sep).filter((part) => part.length > 0);
    if (parts.length >= 2) addNeedle(`${sep}${parts.slice(-2).join(sep)}`, rule);
    const last = parts[parts.length - 1];
    if (shortName && last !== undefined && last.length >= 3) addNeedle(`${sep}${last}`, rule);
    // `cd ~/.config && cat solana/id.json`, `~/.config/sol*/id.json` and `~/.config/'solana'/id.json` never write the full tail,
    // so the dotted parent (`/.config`) and a bare dotted name (`cd ~ && cat .ssh/id`) must trip the guard too.
    if (rule === 'denied_root') {
      const parent = parts[parts.length - 2];
      if (parent !== undefined && parent.startsWith('.') && parent.length >= 3 && !ownSegments.has(parent)) addNeedle(`${sep}${parent}`, rule);
      if (shortName && last !== undefined && last.startsWith('.') && last.length >= 3) for (const lead of [' ', '"', "'", ';', '=']) addNeedle(`${lead}${last}`, rule);
    }
  };
  for (const target of protectedTargets) addTarget(target, 'protected_write');
  // The bare folder-name needle (`/.oms`) is dropped when it would match the task's own path (host worktrees live under `.oms`).
  for (const target of deniedTargets) addTarget(target, 'denied_root', !config.approveHostCommands || !ownSegments.has(basename(target.absolute)));

  return {
    protectedTargets,
    deniedTargets,
    commandNeedles: [...needles].map(([needle, rule]) => ({ needle, rule })),
  };
}

// --- rules ------------------------------------------------------------------------

function label(target: ResolvedPath): string {
  // Project-relative entries read better in a reason; an absolute host path is
  // reduced to its name so the transcript does not carry the machine layout.
  return isAbsolute(target.raw) ? basename(target.raw) : target.raw;
}

function pathDecision(call: GuardedToolCall, targets: PreparedTargets, cwd: string, home: string): GuardDecision | null {
  const spec = PATH_TOOL_SPECS[call.toolName];
  if (spec === undefined) return null;

  const raw = call.input[spec.field];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim().length === 0)) {
    if (REQUIRED_PATH_TOOLS.has(call.toolName)) {
      return block('guard_error', `${call.toolName} was called without a usable path argument`);
    }
    return null;
  }
  if (typeof raw !== 'string') {
    return block('guard_error', `${call.toolName} path argument is not a string`);
  }
  if (raw.includes('\u0000')) {
    return block('guard_error', 'path argument contains a NUL byte');
  }

  const target = resolvePath(raw, cwd, home);
  const candidates = candidatesOf(target);

  if (spec.access === 'write') {
    for (const protectedTarget of targets.protectedTargets) {
      if (matchesTarget(candidates, protectedTarget)) {
        return block(
          'protected_write',
          `${label(protectedTarget)} is digest-pinned and read-only for the model; ask the user to change it`,
        );
      }
    }
  }
  for (const deniedTarget of targets.deniedTargets) {
    if (matchesTarget(candidates, deniedTarget)) {
      return block(
        'denied_root',
        'that path holds key material or signer state; the model may not read or write it',
      );
    }
  }
  return null;
}

/** Whether the command names the path: the needle must end at a path-component boundary, so `/solana` matches
 * `~/.config/solana/id.json` and `solana*` but not a public checkout such as `/solana-labs__solana-program-library`. */
const NAME_CHAR = /[a-z0-9._-]/;
function mentionsPath(haystack: string, needle: string): boolean {
  if (!NAME_CHAR.test(needle.at(-1)!)) return haystack.includes(needle);
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const next = haystack[at + needle.length];
    if (next === undefined || !NAME_CHAR.test(next)) return true;
  }
  return false;
}

function commandDecision(call: GuardedToolCall, targets: PreparedTargets): GuardDecision | null {
  if (!COMMAND_TOOLS.has(call.toolName)) return null;
  const command = call.input.command;
  if (typeof command !== 'string' || command.length === 0) return null;
  const haystack = command.toLowerCase();

  for (const { needle, rule } of targets.commandNeedles) {
    if (!mentionsPath(haystack, needle)) continue;
    return block(
      rule,
      rule === 'denied_root'
        ? 'the command mentions a path that holds key material or signer state; the model may not read or write it'
        : 'the command mentions a digest-pinned file the model may not modify; ask the user to change it',
    );
  }
  return null;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function diffSizeDecision(call: GuardedToolCall, maxEditBytes: number): GuardDecision | null {
  let bytes = 0;
  if (call.toolName === 'write') {
    const content = call.input.content;
    bytes = typeof content === 'string' ? byteLength(content) : 0;
  } else if (call.toolName === 'edit') {
    const edits = call.input.edits;
    if (Array.isArray(edits)) {
      for (const entry of edits) {
        if (entry === null || typeof entry !== 'object') continue;
        const newText = (entry as Record<string, unknown>).newText;
        if (typeof newText === 'string') bytes += byteLength(newText);
      }
    }
  } else {
    return null;
  }
  if (bytes <= maxEditBytes) return null;
  return block(
    'diff_size',
    `this call writes ${bytes} bytes and the per-call limit is ${maxEditBytes}; split it into smaller edits`,
  );
}

function repetitionDecision(
  call: GuardedToolCall,
  threshold: number,
  window: number,
  history: GuardHistory,
): GuardDecision | null {
  const key = canonicalizeToolCall(call);
  const recent = history.slice(Math.max(0, history.length - window));
  let seen = 0;
  for (const sample of recent) if (sample.key === key) seen += 1;
  if (seen + 1 < threshold) return null;
  return block(
    'repetition',
    `this repeats an identical ${call.toolName} call ${seen} time(s) with no new information; change approach or ask the user`,
  );
}

// --- public surface ---------------------------------------------------------------

function stableStringify(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'undefined':
      return 'undefined';
    case 'function':
    case 'symbol':
      return JSON.stringify(typeof value);
    default:
      break;
  }
  const object = value as object;
  if (seen.has(object)) return '"[circular]"';
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      return `[${object.map((item) => stableStringify(item, seen)).join(',')}]`;
    }
    const record = object as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const body = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`).join(',');
    return `{${body}}`;
  } finally {
    seen.delete(object);
  }
}

/** Tool name plus key-sorted JSON of the input: two calls are "the same" iff these match. */
export function canonicalizeToolCall(call: GuardedToolCall): string {
  return `${call.toolName}:${stableStringify(call.input, new Set())}`;
}

/** Sliding-window size the repetition guard reads, so the caller can bound its history. */
function repetitionWindow(config: GuardsConfig): number {
  const window = config.repetition?.window ?? DEFAULT_REPETITION_WINDOW;
  return Number.isFinite(window) && window >= 0 ? Math.floor(window) : DEFAULT_REPETITION_WINDOW;
}

function repetitionThreshold(config: GuardsConfig): number {
  const threshold = config.repetition?.threshold ?? DEFAULT_REPETITION_THRESHOLD;
  // Below 2 the guard would block the first call; clamp to the smallest meaningful value.
  return Number.isFinite(threshold) && threshold >= 2 ? Math.floor(threshold) : DEFAULT_REPETITION_THRESHOLD;
}

function maxEditBytesOf(config: GuardsConfig): number {
  const max = config.maxEditBytes ?? DEFAULT_MAX_EDIT_BYTES;
  return Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_MAX_EDIT_BYTES;
}

/**
 * The whole guard, as a pure-ish function: it reads the filesystem to resolve paths but
 * keeps no state and does not touch Pi. `history` holds the calls that already ran
 * (oldest first); the caller appends after a decision.
 */
export function decideToolCall(call: GuardedToolCall, config: GuardsConfig, history: GuardHistory): GuardDecision {
  if (call === null || typeof call !== 'object' || typeof call.toolName !== 'string') {
    return block('guard_error', 'the guard could not read the tool call');
  }
  const cwd = resolve(config.cwd ?? process.cwd());
  const home = homedir();
  const targets = prepareTargets(config, cwd, home);

  const path = pathDecision(call, targets, cwd, home);
  if (path !== null) return path;
  const command = commandDecision(call, targets);
  if (command !== null) return command;
  const size = diffSizeDecision(call, maxEditBytesOf(config));
  if (size !== null) return size;
  const repeat = repetitionDecision(call, repetitionThreshold(config), repetitionWindow(config), history);
  if (repeat !== null) return repeat;
  return ALLOW;
}

const GUARD_FAILED_CLOSED: GuardDecision = Object.freeze({
  block: true,
  rule: 'guard_error',
  reason: 'blocked (guard_error): the guard could not verify that this call is allowed, so it was refused. Change approach or ask the user',
});

/**
 * Pi extension: one `tool_call` handler applying all three rules. A throw anywhere in
 * the decision path blocks the call.
 */
export function createGuardsExtension(options: GuardsConfig = {}): ExtensionFactory {
  const window = Math.max(repetitionWindow(options), 1);
  return (pi) => {
    const history: ToolCallSample[] = [];
    pi.on('tool_call', (event, ctx) => {
      const call: GuardedToolCall = {
        toolName: String(event.toolName),
        input: (event.input ?? {}) as Record<string, unknown>,
      };
      let decision: GuardDecision;
      try {
        decision = decideToolCall(call, { ...options, cwd: options.cwd ?? ctx?.cwd ?? process.cwd() }, history);
        history.push({ key: canonicalizeToolCall(call) });
        while (history.length > window) history.shift();
      } catch {
        // Fail closed: an exception is never a reason to let the call through.
        decision = GUARD_FAILED_CLOSED;
      }
      if (decision.block) return { block: true, reason: decision.reason };
      return undefined;
    });
  };
}
