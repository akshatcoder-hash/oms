import type { LessonBody } from './types.ts';
const injection = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]|<\/oms-|ignore\b[^.\n]{0,80}\binstructions/i;
export function injectionLint(text: string): boolean { return !injection.test(text); }
export interface ScrubResult { text: string; localOnly: boolean }
/** Allowlist before summarization prevents echoed private identifiers escaping. */
export function scrub(text: string, vocabulary: ReadonlySet<string>, secretForms: readonly string[] = []): ScrubResult {
  if (!injectionLint(text)) throw new Error('Injection rejected');
  let cleaned = text;
  for (const secret of [...secretForms].sort((a, b) => b.length - a.length)) if (secret.length) cleaned = cleaned.split(secret).join('<id>');
  cleaned = cleaned
    .replace(/```[\s\S]*?```/g, '<id>')
    .replace(/https?:\/\/[^\s"'<>]+/g, '<id>')
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<id>')
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,}\b/g, '<id>')
    .replace(/\b(?:0x)?[0-9a-fA-F]{16,}\b/g, '<id>')
    .replace(/(?:[A-Za-z]:\\|\/)[^\s<>"']+/g, '<id>')
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '<id>');
  let localOnly = cleaned !== text;
  cleaned = cleaned.replace(/<(?:id|path|addr|hex|n)>|[\p{L}\p{N}_@][\p{L}\p{N}_@./:+-]{2,}/gu, token => {
    if (/^<(?:id|path|addr|hex|n)>$/.test(token) || vocabulary.has(token.toLowerCase())) return token;
    localOnly = true; return '<id>';
  });
  return { text: cleaned, localOnly };
}
export function scrubBody(body: LessonBody, vocabulary: ReadonlySet<string>, secrets: readonly string[] = []): { body: LessonBody; localOnly: boolean } {
  let localOnly = false;
  const field = (value: string): string => { const result = scrub(value, vocabulary, secrets); localOnly ||= result.localOnly; return result.text; };
  return { body: { symptom: field(body.symptom), rootCause: field(body.rootCause), fixPattern: field(body.fixPattern), avoid: body.avoid === null ? null : field(body.avoid) }, localOnly };
}
