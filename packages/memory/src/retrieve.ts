import type { ErrorSignature } from './normalize.ts';
import type { Lesson } from './types.ts';
import { confidence } from './score.ts';
import { frame } from './frame.ts';
export function recall(signature: ErrorSignature, project: Lesson[], personal: Lesson[], tokenBudget: number): { inline: string; spill: string[]; ids: string[]; tokens: number } {
  const seen = new Set<string>();
  const candidates: { lesson: Lesson; score: number }[] = [];
  for (const scope of [project, personal]) {
    const matches = scope.filter(row => row.tier !== 'retired' && (row.signature.key === signature.key || row.signature.tool === signature.tool && row.signature.code === signature.code))
      .map(lesson => ({ lesson, score: confidence(signature, lesson.signature, lesson.tier) })).filter(row => row.score >= 0.35)
      .sort((a, b) => Number(b.lesson.signature.key === signature.key) - Number(a.lesson.signature.key === signature.key) || b.score - a.score);
    for (const match of matches) if (!seen.has(match.lesson.id)) { seen.add(match.lesson.id); candidates.push(match); }
  }
  const top = candidates[0];
  if (!top || tokenBudget <= 0) return { inline: '', spill: [], ids: [], tokens: 0 };
  const rendered = frame({ id: top.lesson.id, tier: top.lesson.tier === 'quarantined' ? 'unconfirmed' : top.lesson.tier, confidence: top.score, applies: JSON.stringify(top.lesson.applicability.range), symptom: top.lesson.body.symptom, fix: top.lesson.body.fixPattern, avoid: top.lesson.body.avoid, relatedIds: candidates.slice(1, 3).map(row => row.lesson.id) }, Math.min(600, Math.floor(tokenBudget)));
  // UTF-8 bytes conservatively bound tokens; the host may use a model tokenizer instead.
  const tokens = Buffer.byteLength(rendered);
  if (!rendered || tokens > tokenBudget) return { inline: '', spill: [], ids: [], tokens: 0 };
  return { inline: rendered, spill: candidates.slice(1, 3).map(row => row.lesson.id), ids: [top.lesson.id], tokens };
}
