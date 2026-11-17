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
    join(d.personal, 'fixer.md'),
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
  writeFileSync(join(d.personal, 'model.md'), '---\nname: model\ndescription: x\nmodel: gpt\n---\nbody\n');
  writeFileSync(join(d.project, 'empty.md'), '---\nname: empty\ndescription: x\n---\n');
  const { agents, problems } = loadAgents(d);
  assert.deepEqual(
    agents.map((agent) => agent.name),
    ['explore', 'build', 'review'],
  );
  assert.equal(problems.length, 7);
  assert.ok(problems.every((problem) => /^(project|personal): /.test(problem)));
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

test('M2: project files cannot replace built-ins or choose a provider', (t) => {
  const d = dirs(t);
  writeFileSync(join(d.project, 'explore.md'), file('explore', '\ntools: edit'));
  writeFileSync(join(d.project, 'custom.md'), file('custom', '\nmodel: expensive/provider'));
  const { agents, problems } = loadAgents(d);
  assert.equal(agents.find((a) => a.name === 'explore')!.source, 'built-in');
  assert.equal(agents.find((a) => a.name === 'explore')!.tools, 'read');
  assert.equal(agents.find((a) => a.name === 'custom')!.model, undefined);
  assert.match(problems.join('\n'), /explore.*built-in/);
});

test('M2: descriptions inserted into the system prompt are short printable text', (t) => {
  const d = dirs(t);
  writeFileSync(join(d.project, 'large.md'), file('large', 'x'.repeat(121)));
  writeFileSync(join(d.project, 'control.md'), file('control', '\x1b[2J'));
  const { agents, problems } = loadAgents(d);
  assert.ok(!agents.some((a) => a.source === 'project'));
  assert.equal(problems.length, 2);
});
