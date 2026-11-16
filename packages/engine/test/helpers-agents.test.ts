import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { loadAgents, writeAgent } from '../src/runtime/helpers/agents.ts';

function dirs(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'oms-agents-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const found = { personal: join(base, 'personal'), project: join(base, 'project') };
  mkdirSync(found.personal);
  mkdirSync(found.project);
  return found;
}

const file = (name: string, extra = '', body = 'You check things.') =>
  `---\nname: ${name}\ndescription: Checks things ${extra}\n---\n${body}\n`;

test('the three built-in agents exist with their tools', (t) => {
  const { agents, problems } = loadAgents(dirs(t));
  assert.deepEqual(problems, []);
  assert.deepEqual(
    agents.map((agent) => [agent.name, agent.tools, agent.source]),
    [
      ['explore', 'read', 'built-in'],
      ['build', 'edit', 'built-in'],
      ['review', 'read', 'built-in'],
    ],
  );
});

test('a project agent beats a personal one of the same name, which beats a built-in', (t) => {
  const d = dirs(t);
  writeFileSync(join(d.personal, 'auditor.md'), file('auditor', 'personal'));
  writeFileSync(join(d.project, 'auditor.md'), file('auditor', 'project'));
  writeFileSync(join(d.personal, 'explore.md'), file('explore', 'mine'));
  const { agents } = loadAgents(d);
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  assert.equal(byName.get('auditor')!.source, 'project');
  assert.match(byName.get('auditor')!.description, /project/);
  assert.equal(byName.get('explore')!.source, 'personal');
  assert.equal(byName.get('build')!.source, 'built-in');
});

test('tools and model come from the header, and a note after # is dropped', (t) => {
  const d = dirs(t);
  writeFileSync(
    join(d.project, 'fixer.md'),
    '---\nname: fixer\ndescription: Fixes one thing\ntools: edit   # needs files\nmodel: xai/grok-4.7\n---\nFix it.\n',
  );
  const fixer = loadAgents(d).agents.find((agent) => agent.name === 'fixer')!;
  assert.equal(fixer.tools, 'edit');
  assert.equal(fixer.model, 'xai/grok-4.7');
  assert.equal(fixer.instructions, 'Fix it.');
});

test('a bad agent file is listed as a problem and never half-applied', (t) => {
  const d = dirs(t);
  writeFileSync(join(d.project, 'noheader.md'), 'just text');
  writeFileSync(join(d.project, 'Bad_Name.md'), file('Bad_Name'));
  writeFileSync(join(d.project, 'mismatch.md'), file('other'));
  writeFileSync(join(d.project, 'tools.md'), '---\nname: tools\ndescription: x\ntools: bash\n---\nbody\n');
  writeFileSync(join(d.project, 'unknown.md'), '---\nname: unknown\ndescription: x\nallow: all\n---\nbody\n');
  writeFileSync(join(d.project, 'model.md'), '---\nname: model\ndescription: x\nmodel: gpt\n---\nbody\n');
  writeFileSync(join(d.project, 'empty.md'), '---\nname: empty\ndescription: x\n---\n');
  const { agents, problems } = loadAgents(d);
  assert.deepEqual(
    agents.map((agent) => agent.name),
    ['explore', 'build', 'review'],
  );
  assert.equal(problems.length, 7);
  assert.ok(problems.every((problem) => problem.startsWith('project: ')));
});

test('writeAgent makes a file the loader accepts, in the right folder, and never overwrites', (t) => {
  const d = dirs(t);
  const path = writeAgent(d, { name: 'auditor', description: 'Check Anchor accounts', scope: 'project' });
  assert.equal(path, join(d.project, 'auditor.md'));
  const auditor = loadAgents(d).agents.find((agent) => agent.name === 'auditor')!;
  assert.deepEqual([auditor.tools, auditor.source], ['read', 'project']);
  assert.throws(() => writeAgent(d, { name: 'auditor', description: 'again', scope: 'project' }), /already exists/);
  const editor = writeAgent(d, { name: 'editor', description: 'Edit one file', scope: 'personal', tools: 'edit' });
  assert.match(readFileSync(editor, 'utf8'), /tools: edit/);
  assert.equal(loadAgents(d).agents.find((agent) => agent.name === 'editor')!.source, 'personal');
  assert.throws(() => writeAgent(d, { name: 'Bad Name', description: 'x', scope: 'personal' }), /lowercase/);
  assert.throws(() => writeAgent(d, { name: 'ok', description: '  ', scope: 'personal' }), /Say what/);
});
