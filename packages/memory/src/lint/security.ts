import type { LessonBody } from '../types.ts';
const checks = /\bSigner\s*<|#\s*\[\s*account\s*\([^)]*\bsigner\b|\b(?:owner|has_one|constraint|address)\s*=|\b(?:seeds|bump|is_signer|signer)\b|\.owner\b|\bowner\s*(?:!=|==)/;
const unsafeAccount = /\bUncheckedAccount\b|\/\/\/\s*CHECK\b/;
/** Conservative refusal: deleting a check needs human context, never automatic learning. */
export function securityLint(diff: string, body: LessonBody): string[] {
  const issues: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('-') && (checks.test(line) || /(?:==|!=)/.test(line) && /\b\w*owner\w*\b/i.test(line))) issues.push('removed-security-check');
    if (line.startsWith('+') && (unsafeAccount.test(line) || /\bAccountInfo\s*</.test(line))) issues.push('added-unchecked-account');
  }
  const advice = `${body.fixPattern}\n${body.avoid ?? ''}`;
  if (unsafeAccount.test(advice) || /\b(?:remove|disable|skip|bypass|weaken|drop|omit)\b[^.\n]{0,100}\b(?:signer|Signer|owner|has_one|constraint|seeds|bump|address|is_signer|checks?|validation)\b/i.test(advice)) issues.push('unsafe-advice');
  return [...new Set(issues)];
}
