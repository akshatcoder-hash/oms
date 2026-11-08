import { EMPTY_NOTE, REVIEW_DISCLAIMER } from '../disclaimer.ts';
import { parseReviewReport, validLocation, VULN_CLASSES, type ReviewReport } from '../types.ts';

export function emptyReport(input: Pick<ReviewReport, 'reviewId' | 'createdAt' | 'repo'>): ReviewReport {
  return {
    schema: 'oms.review/1', disclaimer: REVIEW_DISCLAIMER, emptyNote: EMPTY_NOTE, ...input, phase: 'A',
    programs: [], tools: [], findings: [],
    coverage: VULN_CLASSES.map(classId => ({ class: classId, verdict: 'unreviewed', evidence: 'Not reviewed.' })),
    totals: { confirmed: 0, suspected: 0, invalidModelOutputs: 0 },
  };
}

function bounded(value: string): string {
  // JSON schema lengths count characters; display limits are bytes.
  let result = '';
  let bytes = 0;
  for (const char of value) {
    bytes += Buffer.byteLength(char);
    if (bytes > 4096) break;
    result += char;
  }
  return result;
}
// Markdown is also printed directly by the CLI. Fences do not neutralize
// terminal controls. Remove them before choosing fences or escaping inline text.
function displayText(value: string): string {
  return bounded(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
function escape(value: string): string {
  return displayText(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#!|~]/g, '\\$&').replace(/[\r\n]/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '');
}
function block(value: string): string {
  const body = displayText(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const longest = Math.max(2, ...Array.from(body.matchAll(/`+/g), match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${body}\n${fence}`;
}

/** Caller supplies the snapshot inventory; invalid locations never reach reports. */
export function prepareReport(input: unknown, files: ReadonlyMap<string, number>): ReviewReport {
  const checked = structuredClone(parseReviewReport(input));
  // Validate original citations before display truncation can change their
  // identity. Reject paths exceeding the display bound rather than shortening
  // them into a different snapshot file.
  const originalCount = checked.findings.length;
  checked.findings = checked.findings.filter(finding =>
    Buffer.byteLength(finding.location.file) <= 4096 && validLocation(finding.location, files));
  for (const finding of checked.findings) {
    finding.staticHits = finding.staticHits.filter(hit =>
      Buffer.byteLength(hit.location.file) <= 4096 && validLocation(hit.location, files));
  }
  checked.totals.invalidModelOutputs += originalCount - checked.findings.length;
  checked.totals.suspected = checked.findings.length;
  if (!checked.findings.length) checked.emptyNote = EMPTY_NOTE;
  else delete checked.emptyNote;
  const report = parseReviewReport(JSON.parse(JSON.stringify(checked, (_key, value: unknown) =>
    typeof value === 'string' ? bounded(value) : value)));
  const severity = ['critical', 'high', 'medium', 'low', 'info'];
  report.findings.sort((a, b) => severity.indexOf(a.severity) - severity.indexOf(b.severity) || a.id.localeCompare(b.id));
  return report;
}

export function renderJson(input: unknown, files: ReadonlyMap<string, number>): string {
  const report = prepareReport(input, files);
  // Keep the disclaimer first; JSON remains the strict report wire format.
  const { disclaimer, ...rest } = report;
  // JSON.stringify escapes C0 controls but leaves DEL/C1 literal. The CLI also
  // prints JSON directly, so escape those without changing decoded evidence.
  return JSON.stringify({ disclaimer, ...rest }, null, 2)
    .replace(/[\x7f-\x9f]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')) + '\n';
}

export function renderMarkdown(input: unknown, files: ReadonlyMap<string, number>): string {
  const report = prepareReport(input, files);
  const lines = [REVIEW_DISCLAIMER, '', `# Security review ${escape(report.reviewId)}`, '',
    'Confirmed 0 · Suspected ' + report.totals.suspected, '',
    report.model ? `Provider: ${escape(report.model.provider)} · Model: ${escape(report.model.model)}` : 'Model: not used.', '',
    '| Class | Verdict | Evidence |', '| --- | --- | --- |',
    ...report.coverage.map(row => `| ${row.class} | ${row.verdict} | ${escape(row.evidence)} |`), '',
  ];
  if (!report.findings.length) lines.push(EMPTY_NOTE, '');
  for (const tool of report.tools) lines.push(`Tool: ${escape(tool.name)} ${escape(tool.version)} — ${tool.status}${tool.reason ? ': ' + escape(tool.reason) : ''}`, '');
  for (const finding of report.findings) {
    lines.push(`## SUSPECTED · ${finding.severity} · ${escape(finding.title)}`, '',
      `${escape(finding.location.file)}:${finding.location.line}`, '', block(finding.explanation), '',
      'Suggested fix (not applied):', '', block(finding.fix), '');
    for (const hit of finding.staticHits) lines.push(`${escape(hit.tool)} / ${escape(hit.ruleId)}: ${escape(hit.message)}`, '');
  }
  if (report.totals.invalidModelOutputs) lines.push(`Rejected findings: ${report.totals.invalidModelOutputs}`, '');
  return lines.join('\n');
}
