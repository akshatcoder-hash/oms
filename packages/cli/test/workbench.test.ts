import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { TaskFileAccess } from '@oms/engine';
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { dispatchMouseEvent } from '@earendil-works/pi-tui/dist/tui.js';
import { getLayoutBoxesAt, renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js';
import { WorkbenchPane } from '../src/tui/workbench.ts';
import { getTheme } from '../src/tui/theme.ts';
import { barrier } from '../test-support/interface-terminal.ts';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(initial: Record<string, string> = { 'a.ts': 'alpha\r\n界🌱', 'src/b.ts': 'beta' }, hostRows = 24) {
  const disk = new Map(Object.entries(initial));
  const notices: string[] = [];
  const files: TaskFileAccess = {
    async list(path = '.') {
      const prefix = path === '.' ? '' : path + '/';
      const entries = new Map<string, 'file' | 'directory'>();
      for (const key of disk.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const name = rest.split('/')[0]!;
        entries.set(prefix + name, rest.includes('/') ? 'directory' : 'file');
      }
      return [...entries].map(([path, kind]) => ({ path, kind })).sort((a, b) => a.path.localeCompare(b.path));
    },
    async read(path) {
      const text = disk.get(path);
      if (text === undefined) throw new Error('file not found');
      return { bytes: Buffer.from(text), revision: digest(text) };
    },
    async write(path, bytes, revision) {
      if (revision !== digest(disk.get(path)!)) throw new Error('file changed after the edit read');
      const text = Buffer.from(bytes).toString('utf8');
      disk.set(path, text);
      return digest(text);
    },
    async create(path, bytes) {
      if (disk.has(path)) throw new Error('file already exists');
      const text = Buffer.from(bytes).toString('utf8');
      disk.set(path, text);
      return digest(text);
    },
    async access() {}, async makeDirectory() {},
  };
  const pane = new WorkbenchPane({ files }, {
    theme: () => getTheme('gruvbox')!, render() {}, notice: message => notices.push(message), focusChanged() {}, rows: () => hostRows,
  });
  pane.focus.focused = true;
  return { pane, files, disk, notices };
}
const rows = (pane: WorkbenchPane, width = 100) => renderLayoutFrame(pane.body, width, 24, () => {}).lines.map(line => stripTerminalSequences(line)).join('\n');

function click(pane: WorkbenchPane, text: string, options: { width?: number; height?: number; count?: number; occurrence?: number } = {}): void {
  const width = options.width ?? 100;
  const height = options.height ?? 24;
  const frame = renderLayoutFrame(pane.body, width, height, () => {});
  let occurrence = options.occurrence ?? 0;
  for (let y = 0; y < frame.lines.length; y++) {
    const line = stripTerminalSequences(frame.lines[y]!);
    let from = 0;
    for (;;) {
      const index = line.indexOf(text, from);
      if (index < 0) break;
      from = index + text.length;
      if (occurrence-- > 0) continue;
      const x = visibleWidth(line.slice(0, index));
      for (const type of ['press', 'release', 'click'] as const) {
        const event: TuiMouseEvent = { type, button: 'left', x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false, clickCount: options.count ?? 1 };
        for (const box of getLayoutBoxesAt(frame, x, y)) {
          const result = dispatchMouseEvent(box.component, { ...event, x: x - box.rect.x, y: y - box.rect.y, width: box.rect.width, height: box.rect.height });
          if (!result) continue;
          if (result.focus) {
            const target = pane.resolveMouseFocus(result.focusTarget ?? result.target.component);
            if (target === pane.focus) pane.focus.focused = true;
          }
          break;
        }
      }
      return;
    }
  }
  assert.fail(`No visible text to click: ${text}`);
}

test('clickable buffer tabs preserve drafts and modal discard remains bound to its target', async () => {
  const { pane, disk } = fixture();
  await pane.open('a.ts'); pane.handleInput('draft');
  await pane.open('src/b.ts');
  click(pane, 'a.ts');
  assert.match(rows(pane), /draftalpha/);
  click(pane, 'Close');
  click(pane, 'b.ts');
  click(pane, 'Files');
  pane.handleInput('discard'); pane.handleInput('\r');
  assert.equal(pane.dirty, false);
  assert.match(rows(pane), /beta/);
  await pane.save();
  assert.equal(disk.get('src/b.ts'), 'beta');
  await pane.open('a.ts');
  assert.doesNotMatch(rows(pane), /draftalpha/);
});

test('browser pointer rows remain aligned after scroll and frame borders; single click selects, double click opens', async () => {
  const initial = Object.fromEntries(Array.from({ length: 40 }, (_, n) => [`file${String(n).padStart(2, '0')}.ts`, `content${n}`]));
  const { pane } = fixture(initial);
  await pane.open();
  pane.handleInput('\x1b[F');
  const screen = rows(pane);
  assert.match(screen, /file39.ts/);
  click(pane, 'file38.ts');
  assert.doesNotMatch(rows(pane), /content38/);
  pane.handleInput('\r'); await setImmediate();
  assert.match(rows(pane), /content38/);
  await pane.open();
  click(pane, 'file01.ts', { count: 2 }); await setImmediate();
  assert.match(rows(pane), /content1/);
});

test('pointer selects the active split and preserves editing Tab and slash keys', async () => {
  const { pane, disk } = fixture({ 'a.ts': 'alpha', 'b.ts': 'beta' });
  await pane.open('a.ts'); pane.split(); pane.handleInput('\x1c'); await pane.open('b.ts');
  click(pane, 'alpha');
  pane.handleInput('\t'); pane.handleInput('/');
  await pane.save();
  assert.equal(disk.get('a.ts'), '\t/alpha');
  assert.equal(disk.get('b.ts'), 'beta');
});

test('toolbar save and close are inert with no buffer or while saving', async () => {
  const { pane, files, disk } = fixture();
  let writes = 0;
  const write = files.write;
  const gate = barrier<void>();
  files.write = async (...args) => { writes++; await gate.promise; return write(...args); };
  click(pane, 'Save'); click(pane, 'Close');
  assert.equal(writes, 0);
  await pane.open('a.ts'); pane.handleInput('X');
  click(pane, 'Save'); click(pane, 'Save'); click(pane, 'Close');
  assert.equal(writes, 1);
  assert.doesNotMatch(rows(pane), /Confirm discard/);
  gate.resolve(); await setImmediate();
  assert.equal(disk.get('a.ts'), 'Xalpha\r\n界🌱');
  assert.match(rows(pane), /Xalpha/);
});

test('compact empty, browser and split editor keep useful content visible with Unicode tabs bounded', async () => {
  const { pane } = fixture({ '界🌱.ts': 'visible source', 'b.ts': 'second' }, 12);
  const compact = () => renderLayoutFrame(pane.body, 40, 6, () => {}).lines.map(line => stripTerminalSequences(line));
  assert.match(compact().join('\n'), /No file open/);
  await pane.open();
  assert.match(compact().join('\n'), /界🌱/);
  await pane.open('界🌱.ts'); pane.split();
  assert.match(compact().join('\n'), /visible source/);
  assert.ok(compact().every(line => visibleWidth(line) <= 40));
  await pane.open('b.ts'); click(pane, '界🌱.ts', { width: 40, height: 6 });
  assert.match(compact().join('\n'), /visible source/);
});

test('explicit pointer split change invalidates a delayed file activation', async () => {
  const { pane, files, disk } = fixture({ 'a.ts': 'alpha', 'b.ts': 'beta', 'c.ts': 'charlie' });
  await pane.open('a.ts'); pane.split(); pane.handleInput('\x1c'); await pane.open('b.ts');
  const gate = barrier<void>();
  const read = files.read;
  files.read = async (...args) => { if (args[0] === 'c.ts') await gate.promise; return read(...args); };
  const pending = pane.open('c.ts');
  click(pane, 'alpha');
  pane.handleInput('X');
  gate.resolve(); await pending;
  assert.doesNotMatch(rows(pane), /charlie/);
  await pane.save();
  assert.equal(disk.get('a.ts'), 'Xalpha');
  assert.equal(disk.get('b.ts'), 'beta');
});

test('find modal blocks background pointer selection and tab mutations', async () => {
  const { pane, disk } = fixture({ 'a.ts': 'alpha', 'b.ts': 'beta' });
  await pane.open('b.ts'); await pane.open('a.ts');
  pane.find();
  click(pane, 'pha');
  click(pane, 'b.ts');
  click(pane, 'New');
  pane.handleInput('\x1b'); pane.handleInput('X'); await pane.save();
  assert.equal(disk.get('a.ts'), 'Xalpha');
  assert.equal(disk.get('b.ts'), 'beta');
});

test('async activation rebuilds without issuing a pointer focus request', async () => {
  const { files } = fixture();
  let requests = 0;
  let rebuilds = 0;
  const pane = new WorkbenchPane({ files }, {
    theme: () => getTheme('gruvbox')!, render() {}, notice() {},
    focusChanged() { rebuilds++; }, requestFocus() { requests++; },
  });
  await pane.open('a.ts');
  assert.ok(rebuilds > 0);
  assert.equal(requests, 0);
  click(pane, 'alpha');
  assert.ok(requests > 0);
});

test('clipped Unicode tabs have no hidden activation area', async () => {
  const longName = '界'.repeat(30) + '.ts';
  const { pane, disk } = fixture({ 'a.ts': 'alpha', [longName]: 'other' });
  await pane.open('a.ts'); await pane.open(longName); await pane.open('a.ts');
  click(pane, '界界界', { width: 40 });
  pane.handleInput('X'); await pane.save();
  assert.equal(disk.get('a.ts'), 'Xalpha');
  assert.equal(disk.get(longName), 'other');
  assert.ok(renderLayoutFrame(pane.body, 40, 24, () => {}).lines.every(line => visibleWidth(line) <= 40));
});

test('late reads cannot dismiss a pending dirty close confirmation', async () => {
  const { pane, files } = fixture({ 'a.ts': 'alpha', 'b.ts': 'beta' });
  await pane.open('a.ts'); pane.handleInput('draft');
  const gate = barrier<void>();
  const read = files.read;
  files.read = async (...args) => { await gate.promise; return read(...args); };
  const pending = pane.open('b.ts');
  pane.closeBuffer();
  gate.resolve(); await pending;
  assert.match(rows(pane), /Confirm discard/);
  assert.doesNotMatch(rows(pane), /beta/);
  pane.handleInput('discard'); pane.handleInput('\r');
  assert.equal(pane.dirty, false);
  assert.match(rows(pane), /No file open/);
});

test('empty workbench does no IO and browser navigates directories and opens a document', async () => {
  const { pane, files } = fixture();
  let reads = 0;
  const read = files.read; files.read = async (...args) => { reads++; return read(...args); };
  assert.match(rows(pane), /Ctrl\+P/);
  assert.equal(reads, 0);
  await pane.open();
  assert.match(rows(pane), /Files/);
  pane.handleInput('\x1b[B'); pane.handleInput('\r'); await setImmediate();
  assert.match(rows(pane), /src/);
  pane.handleInput('\x1b[B'); pane.handleInput('\r'); await setImmediate();
  assert.match(rows(pane), /b.ts/);
  assert.match(rows(pane), /beta/);
  assert.match(rows(pane), /Ln 1.*Col 1/);
  assert.equal(reads, 1);
});

test('save preserves BOM, mixed EOL, Unicode and revisions; conflicts stay visible and dirty', async () => {
  const original = '\ufeffalpha\r\n界🌱\nlast';
  const { pane, disk, notices } = fixture({ 'a.ts': original });
  await pane.open('a.ts');
  await pane.save();
  assert.equal(disk.get('a.ts'), original);
  pane.handleInput('\x1b[1;5F'); pane.handleInput('!');
  await pane.save();
  assert.equal(disk.get('a.ts'), original + '!');
  assert.equal(pane.dirty, false);
  pane.handleInput('draft'); disk.set('a.ts', 'external');
  await pane.save();
  assert.equal(disk.get('a.ts'), 'external');
  assert.equal(pane.dirty, true);
  assert.match(notices.at(-1)!, /changed/);
  assert.match(rows(pane), /changed/);
});

test('tabs and split views share documents and never discard a dirty draft on reopen', async () => {
  const { pane, disk } = fixture();
  const focus = pane.focus;
  await pane.open('a.ts'); pane.handleInput('X');
  await pane.open('src/b.ts'); pane.handleInput('Y');
  pane.nextBuffer(); pane.split();
  assert.match(rows(pane), /Xalpha/);
  assert.equal(rows(pane).split('Xalpha').length - 1, 2);
  pane.handleInput('Z');
  assert.equal(rows(pane).split('XZalpha').length - 1, 2);
  await pane.open('./a.ts'); await pane.save();
  assert.equal(disk.get('a.ts'), 'XZalpha\r\n界🌱');
  assert.equal(pane.focus, focus);
  pane.nextBuffer(); await pane.save();
  assert.equal(disk.get('src/b.ts'), 'Ybeta');
  pane.dispose();
});

test('find and replace operate on graphemes and replacement is undoable', async () => {
  const { pane, disk } = fixture({ 'a.ts': '界🌱 alpha alpha' });
  await pane.open('a.ts');
  pane.find(); pane.handleInput('界🌱'); pane.handleInput('\r'); pane.handleInput('\x1b');
  pane.handleInput('garden'); pane.handleInput('\x1a');
  pane.replace(); pane.handleInput('\x01'); pane.handleInput('alpha'); pane.handleInput('\r');
  pane.handleInput('beta'); pane.handleInput('\r'); pane.handleInput('\x1b');
  await pane.save(); assert.equal(disk.get('a.ts'), '界🌱 beta alpha');
  pane.handleInput('\x1a'); await pane.save();
  assert.equal(disk.get('a.ts'), '界🌱 alpha alpha');
});

test('dirty close requires explicit discard, Escape preserves edits', async () => {
  const { pane } = fixture();
  await pane.open('a.ts'); pane.handleInput('draft'); pane.closeBuffer();
  assert.equal(pane.dirty, true); assert.match(rows(pane), /discard/);
  pane.handleInput('\r'); assert.equal(pane.dirty, true);
  pane.handleInput('\x1b'); assert.match(rows(pane), /draftalpha/);
  pane.closeBuffer(); pane.handleInput('discard'); pane.handleInput('\r');
  assert.equal(pane.dirty, false);
  pane.handleInput('ignored without a buffer');
  await pane.open('a.ts');
  assert.doesNotMatch(rows(pane), /draftalpha|ignored without a buffer/);
});

test('typing during save remains dirty and close cannot race an outstanding save', async () => {
  const { pane, files, disk } = fixture();
  await pane.open('a.ts'); pane.handleInput('X');
  const write = files.write;
  const gate = barrier<void>();
  files.write = async (...args) => { await gate.promise; return write(...args); };
  const saved = pane.save(); pane.handleInput('Y'); pane.closeBuffer();
  assert.match(rows(pane), /saving|save.*progress/i);
  gate.resolve(); await saved;
  assert.equal(disk.get('a.ts'), 'Xalpha\r\n界🌱'); assert.equal(pane.dirty, true);
  await pane.save(); assert.equal(disk.get('a.ts'), 'XYalpha\r\n界🌱');
});

test('late file reads cannot replace a newer open or resurrect after disposal', async () => {
  const { pane, files } = fixture();
  const read = files.read;
  const gate = barrier<void>();
  files.read = async (...args) => { if (args[0] === 'a.ts') await gate.promise; return read(...args); };
  const first = pane.open('a.ts'); await pane.open('src/b.ts'); gate.resolve(); await first;
  assert.match(rows(pane), /beta/); assert.doesNotMatch(rows(pane), /alpha/);
  pane.dispose(); await pane.open('a.ts'); assert.doesNotMatch(rows(pane), /alpha/);
});

test('read-only verifier errors are visible and do not mark the document saved', async () => {
  const { pane, files, notices } = fixture();
  await pane.open('a.ts'); pane.handleInput('X');
  files.write = async () => { throw new Error('Verifier files are read-only'); };
  await pane.save();
  assert.equal(pane.dirty, true); assert.match(rows(pane), /read-only/);
  assert.match(notices.at(-1)!, /read-only/);
});

test('split source and captions remain bounded and only the active editor emits a cursor', async () => {
  const { pane } = fixture();
  await pane.open('a.ts'); pane.split();
  for (const width of [1, 8, 40, 100]) {
    const rendered = renderLayoutFrame(pane.body, width, 24, () => {}).lines;
    assert.ok(rendered.every(line => visibleWidth(line) <= width));
    assert.equal(rendered.filter(line => line.includes(CURSOR_MARKER)).length, 1);
  }
});

test('split focus opens another file without changing the first pane or losing Unicode input', async () => {
  const { pane, disk } = fixture();
  await pane.open('a.ts'); pane.split(); pane.handleInput('\x1c');
  await pane.open('src/b.ts');
  pane.handleInput('\ud83c'); pane.handleInput('\udf31'); pane.handleInput('界');
  await pane.save();
  assert.equal(disk.get('src/b.ts'), '🌱界beta');
  assert.match(rows(pane), /alpha/);
  assert.match(rows(pane), /🌱界beta/);
  pane.handleInput('\x1c'); pane.handleInput('X'); await pane.save();
  assert.equal(disk.get('a.ts'), 'Xalpha\r\n界🌱');
  assert.equal(disk.get('src/b.ts'), '🌱界beta');
});

test('filename and query metadata never produce multiline or control-bearing chrome', async () => {
  const { pane } = fixture({ 'line\nname.ts': 'alpha' });
  await pane.open('line\nname.ts');
  assert.ok(renderLayoutFrame(pane.body, 80, 24, () => {}).lines.every(line => !line.includes('\n') && !line.includes('\r')));
  pane.replace(); pane.handleInput('\x1b[200~alpha\nbeta\x1b[201~'); pane.handleInput('\r');
  assert.ok(renderLayoutFrame(pane.body, 80, 24, () => {}).lines.every(line => !line.includes('\n') && !line.includes('\r')));
});

test('new file prompt creates only an unsaved buffer; first save preserves Unicode bytes', async () => {
  const { pane, disk } = fixture();
  pane.handleInput('\x0e'); pane.handleInput('new.ts'); pane.handleInput('\r');
  assert.equal(disk.has('new.ts'), false);
  assert.equal(pane.dirty, true);
  pane.handleInput('\x1b[200~\ufeff界🌱\r\nlast\x1b[201~');
  await pane.save();
  assert.equal(disk.get('new.ts'), '\ufeff界🌱\r\nlast');
  assert.equal(pane.dirty, false);
  pane.handleInput('!'); await pane.save();
  assert.equal(disk.get('new.ts'), '\ufeff界🌱\r\nlast!');
});

test('new-file save never overwrites an existing or concurrently created file', async () => {
  const { pane, disk, notices } = fixture();
  pane.newFile('a.ts'); pane.handleInput('draft'); await pane.save();
  assert.equal(disk.get('a.ts'), 'alpha\r\n界🌱');
  assert.equal(pane.dirty, true);
  assert.match(notices.at(-1)!, /exists/);
  pane.newFile('raced.ts'); pane.handleInput('draft');
  disk.set('raced.ts', 'external creation');
  await pane.save();
  assert.equal(disk.get('raced.ts'), 'external creation');
  assert.equal(pane.dirty, true);
});

test('empty new buffers need discard confirmation and open-buffer names cannot be replaced', async () => {
  const { pane, notices } = fixture();
  await pane.open('a.ts'); pane.handleInput('keep');
  pane.newFile('./a.ts');
  assert.match(notices.at(-1)!, /already open/);
  assert.match(rows(pane), /keepalpha/);
  pane.newFile('empty.ts'); pane.closeBuffer();
  assert.equal(pane.dirty, true);
  assert.match(rows(pane), /discard/);
  pane.handleInput('\x1b');
  await pane.save();
  pane.closeBuffer();
  assert.match(rows(pane), /keepalpha/);
});

test('new-file path prompt rejects multiline, private and escaping names without disk writes', () => {
  const { pane, disk, notices } = fixture();
  for (const path of ['../escape', '.oms/private', '.keys/new', '.env.agent', 'line\nname']) pane.newFile(path);
  assert.equal(disk.size, 2);
  assert.equal(pane.dirty, false);
  assert.equal(notices.length, 5);
});

test('typing during first creation stays dirty and subsequent save uses the returned revision', async () => {
  const { pane, files, disk } = fixture();
  pane.newFile('new.ts'); pane.handleInput('first');
  const create = files.create;
  const gate = barrier<void>();
  files.create = async (...args) => { await gate.promise; return create(...args); };
  const saving = pane.save(); pane.handleInput(' later');
  gate.resolve(); await saving;
  assert.equal(disk.get('new.ts'), 'first');
  assert.equal(pane.dirty, true);
  await pane.save();
  assert.equal(disk.get('new.ts'), 'first later');
  assert.equal(pane.dirty, false);
});

test('switching split sides invalidates a delayed file activation', async () => {
  const { pane, files, disk } = fixture({ 'a.ts': 'alpha', 'b.ts': 'beta', 'c.ts': 'charlie' });
  await pane.open('a.ts'); pane.split(); pane.handleInput('\x1c');
  await pane.open('b.ts');
  const gate = barrier<void>();
  const read = files.read;
  files.read = async (...args) => { if (args[0] === 'c.ts') await gate.promise; return read(...args); };
  try {
    const opening = pane.open('c.ts');
    pane.handleInput('\x1c');
    gate.resolve(); await opening;
    pane.handleInput('X'); await pane.save();
    assert.equal(disk.get('a.ts'), 'Xalpha');
    assert.equal(disk.get('b.ts'), 'beta');
    assert.equal(disk.get('c.ts'), 'charlie');
    assert.doesNotMatch(rows(pane), /charlie/);
  } finally { gate.resolve(); pane.dispose(); }
});

test('report tabs are read-only across typing, paste, replace, save and split without task IO', async () => {
  const { pane, disk, files } = fixture();
  const before = [...disk];
  let reads = 0;
  files.read = async () => { reads++; throw new Error('report must not read task files'); };
  pane.openReport('review-1', 'Confirmed 0 · Suspected 1\nNot a professional audit\nREPORT TEXT');
  assert.match(rows(pane), /Not a professional audit/);
  for (const input of ['changed', '\x1b[200~PASTE\x1b[201~', '\x7f', '\r', '\x1a']) pane.handleInput(input);
  pane.replace(); pane.handleInput('replacement');
  await pane.save();
  pane.split(); pane.handleInput('\x1c'); pane.handleInput('changed split'); await pane.save();
  assert.equal(pane.dirty, false);
  assert.match(rows(pane), /REPORT TEXT/);
  assert.doesNotMatch(rows(pane), /PASTE|changed split|replacement/);
  assert.deepEqual([...disk], before);
  assert.equal(reads, 0);
  pane.closeBuffer();
  assert.equal(pane.dirty, false);
  pane.dispose();
});

test('report completion during a prompt preserves input and opens after the prompt closes', () => {
  const { pane, disk } = fixture();
  pane.newFile(); pane.handleInput('draft-path');
  pane.openReport('queued-review', 'Not a professional audit\nQueued report');
  assert.match(rows(pane), /draft-path/);
  assert.match(rows(pane), /close this prompt/);
  pane.handleInput('\x1b');
  assert.match(rows(pane), /Queued report/);
  assert.equal(pane.dirty, false);
  assert.equal(disk.has('draft-path'), false);
  pane.dispose();
});
