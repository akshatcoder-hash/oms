import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_NOTE, REVIEW_DISCLAIMER, VULN_CLASSES, emptyReport, parseReviewReport,
  parseModelFindings, renderJson, renderMarkdown, prepareReport, type ModelFinding, type Finding } from '../src/index.ts';

const files = new Map([['src/lib.rs', 20]]);
const empty = () => emptyReport({ reviewId: 'r1', createdAt: '2026-11-08T12:00:00Z', repo: { commit: 'abc', dirty: false } });
const model = (): ModelFinding => ({ class: 'missing-signer', handler: 'withdraw',
  location: { file: 'src/lib.rs', line: 10 }, title: 'Missing authority check', explanation: 'No signer constraint.',
  fix: 'Require the authority to sign.', confidence: 'high' });
const finding = (): Finding => ({ id: 'f1', label: 'suspected', class: 'missing-signer', severity: 'high',
  title: model().title, location: model().location, sources: ['model'], explanation: model().explanation, fix: model().fix, staticHits: [] });
const populated = () => {
  const report = empty();
  delete report.emptyNote;
  report.findings = [finding()];
  report.totals.suspected = 1;
  return report;
};

test('empty reports carry one disclaimer, empty note and all 14 coverage rows', () => {
  for (const output of [renderMarkdown(empty(), files), renderJson(empty(), files)]) {
    assert.equal(output.split(REVIEW_DISCLAIMER).length - 1, 1);
    assert.ok(output.includes('Not a professional audit'));
    assert.ok(output.includes(EMPTY_NOTE));
  }
  const json = parseReviewReport(JSON.parse(renderJson(empty(), files)));
  assert.deepEqual(json.coverage.map(row => row.class), VULN_CLASSES);
  assert.equal(json.coverage.every(row => row.verdict === 'unreviewed'), true);
  assert.equal(renderMarkdown(empty(), files).split('\n').filter(row => /^\| [a-z]/.test(row)).length, 14);
});

test('strict schemas reject unknown keys at every nested boundary', () => {
  const report = populated();
  const nodes = [report, report.repo, report.totals, report.coverage[0], report.findings[0], report.findings[0]!.location];
  for (const node of nodes) {
    Object.assign(node!, { unexpected: true });
    assert.throws(() => parseReviewReport(report));
    delete (node as Record<string, unknown>)['unexpected'];
  }
  assert.throws(() => parseReviewReport({ ...empty(), coverage: Array(14).fill(empty().coverage[0]) }));
  assert.throws(() => parseReviewReport({ ...report, totals: { ...report.totals, suspected: 0 } }));
});

test('Phase A rejects confirmed labels even with forged evidence', () => {
  for (const extras of [{}, { exploit: { verdict: { status: 'confirmed' } } }]) {
    const report = populated();
    Object.assign(report.findings[0]!, { label: 'confirmed', ...extras });
    assert.throws(() => parseReviewReport(report));
    assert.throws(() => renderMarkdown(report, files));
    assert.throws(() => renderJson(report, files));
  }
});

test('traversal, absolute paths, unknown files and invalid lines are dropped and counted', () => {
  const locations = [
    { file: '../secret', line: 1 }, { file: '/etc/passwd', line: 1 }, { file: 'C:/secret', line: 1 },
    { file: 'src/../lib.rs', line: 1 }, { file: 'src\\lib.rs', line: 1 }, { file: 'src/lib.rs', line: 21 },
    { file: 'src/lib.rs', line: 0 }, { file: 'unknown.rs', line: 1 },
    { file: 'src/lib.rs', line: 10, endLine: 9 }, { file: 'src/lib.rs', line: 10, endLine: 21 },
  ];
  const result = parseModelFindings([...locations.map(location => ({ ...model(), location })), model()], files);
  assert.equal(result.invalidModelOutputs, locations.length);
  assert.deepEqual(result.findings, [model()]);
  const report = populated();
  report.findings[0]!.location.file = '../secret';
  const cleaned = prepareReport(report, files);
  assert.equal(cleaned.findings.length, 0);
  assert.equal(cleaned.totals.invalidModelOutputs, 1);
  assert.equal(cleaned.emptyNote, EMPTY_NOTE);
  assert.doesNotThrow(() => parseReviewReport(cleaned));
  assert.equal(report.findings.length, 1, 'input stays unchanged');
});

test('invalid model fields are counted, never coerced', () => {
  const invalid = [null, {}, { ...model(), write: 'x' }, { ...model(), class: 'invented' },
    { ...model(), title: 'x'.repeat(4097) }, { ...model(), location: { ...model().location, line: '1' } }];
  assert.equal(parseModelFindings(invalid, files).invalidModelOutputs, invalid.length);
});

test('Markdown escapes HTML and links and contains hostile fences', () => {
  const report = populated();
  report.findings[0]!.title = '<img src=x> [click](https://example.com)';
  report.findings[0]!.explanation = '````\n<script>alert(1)</script>\n````';
  const output = renderMarkdown(report, files);
  assert.ok(!output.includes('<script>'));
  assert.ok(!output.includes('<img'));
  assert.ok(!output.includes('[click]('));
  assert.ok(output.includes('`````text\n````'));
  assert.ok(output.includes('&lt;script&gt;'));
});

 test('both renderers cap Unicode fields by bytes and drop zero lines', () => {
  const report = populated();
  report.findings[0]!.explanation = '界'.repeat(4096);
  const json = parseReviewReport(JSON.parse(renderJson(report, files)));
  assert.ok(Buffer.byteLength(json.findings[0]!.explanation) <= 4096);
  assert.ok(!json.findings[0]!.explanation.includes('\ufffd'));
  report.findings[0]!.location.line = 0;
  const dropped = parseReviewReport(JSON.parse(renderJson(report, files)));
  assert.equal(dropped.totals.invalidModelOutputs, 1);
  assert.equal(dropped.findings.length, 0);
  assert.ok(renderMarkdown(report, files).includes(EMPTY_NOTE));
});


test('Markdown cannot emit terminal controls from untrusted report fields', () => {
  const report = populated();
  const hostile = 'before\x1b]52;c;Y2xpcGJvYXJk\x07after\rhidden\x9b2J\x9dtitle\x9c';
  report.findings[0]!.title = hostile;
  report.findings[0]!.explanation = hostile + '\nline two\tindented';
  report.findings[0]!.fix = hostile;
  report.coverage[0]!.evidence = hostile;
  report.tools.push({ name: hostile, version: hostile, status: 'failed', reason: hostile });
  const output = renderMarkdown(report, files);
  assert.doesNotMatch(output, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  assert.ok(output.includes('line two\tindented'));
  assert.equal(output.split(REVIEW_DISCLAIMER).length - 1, 1);
  assert.equal(report.findings[0]!.explanation, hostile + '\nline two\tindented', 'rendering leaves input intact');
  assert.equal(JSON.parse(renderJson(report, files)).findings[0].explanation, report.findings[0]!.explanation,
    'structured evidence remains intact in JSON');
});

test('JSON text escapes raw C1 terminal controls without altering decoded evidence', () => {
  const report = populated();
  const evidence = '\x7f\x80\x85\x9b2J\x9dtitle\x9c';
  report.findings[0]!.explanation = evidence;
  const json = renderJson(report, files);
  assert.doesNotMatch(json, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  assert.equal(JSON.parse(json).findings[0].explanation, evidence);
});

test('field truncation cannot turn an invalid source location into a valid one', () => {
  const prefix = 'src/' + '界'.repeat(1364);
  assert.equal(Buffer.byteLength(prefix), 4096);
  const inventory = new Map([[prefix, 20]]);
  const report = populated();
  report.findings[0]!.location.file = prefix + '/outside.rs';
  const cleaned = prepareReport(report, inventory);
  assert.equal(cleaned.findings.length, 0);
  assert.equal(cleaned.totals.invalidModelOutputs, 1);
  assert.equal(cleaned.emptyNote, EMPTY_NOTE);

  const bothPaths = new Map([...inventory, [prefix + '/outside.rs', 20] as const]);
  assert.equal(prepareReport(report, bothPaths).findings.length, 0,
    'even a known oversized path must not be shortened to another known file');

  const withHit = populated();
  withHit.findings[0]!.staticHits.push({ tool: 'oms-sast', ruleId: 'test', class: 'missing-signer',
    severity: 'high', location: { file: prefix + '/outside.rs', line: 1 }, message: 'Invalid citation' });
  const mixedInventory = new Map([...files, ...inventory]);
  const filtered = prepareReport(withHit, mixedInventory);
  assert.equal(filtered.findings.length, 1);
  assert.equal(filtered.findings[0]!.staticHits.length, 0);
  assert.equal(withHit.findings[0]!.staticHits.length, 1, 'input stays unchanged');
});
