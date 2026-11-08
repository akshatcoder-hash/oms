import { createHash } from 'node:crypto';

export type SignatureKind = 'build' | 'test' | 'tool' | 'verifier';
export type SignatureTool = 'anchor' | 'cargo' | 'rustc' | 'surfpool' | 'node' | 'tsc' | 'solana' | 'other';
export interface ErrorSignature { kind: SignatureKind; tool: SignatureTool; code: string | null; normalized: string; key: string }
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Never accepts command output as verification evidence; this only classifies text. */
export function normalize(output: string, kind: SignatureKind, tool: SignatureTool): ErrorSignature {
  const line = output.split(/\r?\n/).find(line => /\berror\b|\bfailed\b|\bpanicked\b/i.test(line)) ?? output.split(/\r?\n/)[0] ?? '';
  // TypeScript CLI locations may be relative, absolute, or Windows paths.
  const diagnostic = tool === 'tsc' ? line.replace(/^.+?(?=\(\d+,\d+\):\s*error\s+TS\d+\b)/, '<path>') : line;
  const unquoted = diagnostic.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '<id>');
  const rust = unquoted.match(/\bE\d{4}\b/);
  const ts = unquoted.match(/\bTS(\d+)\b/);
  const named = unquoted.match(/\b(?:rustc:E\d{4}|anchor:\d+|program:0x[0-9a-f]+|ts:\d+)\b/i);
  const code = named?.[0] ?? (rust ? `rustc:${rust[0]}` : ts ? `ts:${ts[1]}` : null);
  // Split around public codes/placeholders rather than using mutable sentinels.
  const parts = unquoted.split(/(<(?:path|addr|hex|n|id)>|\b(?:rustc:E\d{4}|anchor:\d+|program:0x[0-9a-f]+|ts:\d+|E\d{4}|TS\d+)\b)/gi);
  let normalized = parts.map((part, index) => index % 2 ? part : part
    .replace(/[^\s<>"'`]*[\\/][^\s<>"'`]*/g, '<path>')
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, '<addr>')
    .replace(/\b(?:0x)?[0-9a-fA-F]{9,}\b/g, '<hex>')
    .replace(/\d+/g, '<n>')).join('').replace(/\s+/g, ' ').trim();
  if (code && normalized !== code && !normalized.startsWith(code + ' ')) normalized = `${code} ${normalized}`;
  // Keep complete tokens: a cut code or placeholder can change on the next pass.
  if (normalized.length > 240) {
    const boundary = normalized.lastIndexOf(' ', 240);
    normalized = boundary > 0 ? normalized.slice(0, boundary) : '<id>';
  }
  return { kind, tool, code, normalized, key: sha256(`${kind}|${tool}|${code ?? ''}|${normalized}`) };
}
