import assert from 'node:assert/strict';
import { test } from 'node:test';
import xterm from '@xterm/headless';
import type { Terminal } from '@xterm/headless';
import unicodeGraphemes from '@xterm/addon-unicode-graphemes';
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { THEME_IDS, colorText, getTheme, paintThemeRow, type OmsTheme, type ThemeRole } from '../src/tui/theme.ts';

function theme(name: string): OmsTheme {
  const value = getTheme(name);
  assert.ok(value, `Missing curated theme ${name}`);
  return value;
}

async function parsedRow(output: string, width: number): Promise<Terminal> {
  const vt = new xterm.Terminal({ cols: width, rows: 2, allowProposedApi: true, logLevel: 'off' });
  vt.loadAddon(new unicodeGraphemes.UnicodeGraphemesAddon());
  vt.unicode.activeVersion = '15-graphemes';
  // TUI consumes hardware-cursor markers before handing rendered bytes to a VT.
  await new Promise<void>((resolve) => vt.write(output.replaceAll(CURSOR_MARKER, ''), resolve));
  return vt;
}

function rgb(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}
function luminance(hex: string): number {
  const linear = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

test('rows preserve terminal-default backgrounds through nested resets and padding', async () => {
  const vt = await parsedRow('\x1b[48;2;1;2;3m' + paintThemeRow(theme('gruvbox'), 'A\x1b[0mB\x1b[49mC', 9), 9);
  try {
    const line = vt.buffer.active.getLine(0)!;
    assert.equal(line.translateToString(false).trimEnd(), 'ABC');
    for (let column = 0; column < 9; column++) {
      assert.ok(line.getCell(column)!.isBgDefault(), `column ${column} overrides the terminal background`);
    }
  } finally {
    vt.dispose();
  }
});

for (const id of THEME_IDS) {
  test(`${id}: empty and short rows use terminal-default backgrounds including trailing blanks`, async () => {
    const palette = theme(id);
    for (const text of ['', 'OMS']) {
      const output = paintThemeRow(palette, text, 11);
      assert.equal(visibleWidth(output), 11);
      const vt = await parsedRow('\x1b[48;2;1;2;3m' + output, 11);
      try {
        const line = vt.buffer.active.getLine(0)!;
        assert.equal(line.translateToString(false).trimEnd(), text);
        for (let column = 0; column < 11; column++) {
          const cell = line.getCell(column)!;
          assert.ok(cell.isBgDefault(), `column ${column} overrides the terminal background`);
          assert.ok(cell.isFgRGB());
          assert.equal(cell.getFgColor(), rgb(palette.colors.foreground));
        }
      } finally {
        vt.dispose();
      }
    }
  });

  test(`${id}: nested resets restore row foreground without overriding terminal backgrounds`, async () => {
    const palette = theme(id);
    const text = colorText(palette, 'warning', 'A') + 'B\x1b[0mC\x1b[39mD\x1b[49mE\x1b[mF\x1b[0;1mG\x1b[22mH';
    const vt = await parsedRow(paintThemeRow(palette, text, 12), 12);
    try {
      const line = vt.buffer.active.getLine(0)!;
      assert.equal(line.translateToString(false).trimEnd(), 'ABCDEFGH');
      for (let column = 0; column < 12; column++) {
        const cell = line.getCell(column)!;
        assert.ok(cell.isBgDefault());
        assert.ok(cell.isFgRGB());
        assert.equal(cell.getFgColor(), rgb(column === 0 ? palette.colors.warning : palette.colors.foreground));
      }
    } finally {
      vt.dispose();
    }
  });

  test(`${id}: body and status roles have readable contrast using valid RGB palette data`, () => {
    const palette = theme(id);
    assert.match(palette.background, /^#[0-9a-f]{6}$/i);
    assert.match(palette.surface, /^#[0-9a-f]{6}$/i);

    for (const role of ['foreground', 'muted', 'accent', 'success', 'warning', 'error', 'border'] as const) {
      assert.match(palette.colors[role], /^#[0-9a-f]{6}$/i);
      if (role === 'border') continue;
      const a = luminance(palette.colors[role]);
      const b = luminance(palette.background);
      assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, `${id}.${role} fails normal-text contrast`);
    }
  });
}
test('truecolor channel zeros are not mistaken for SGR reset parameters', async () => {
  const palette = theme('gruvbox');
  const vt = await parsedRow(paintThemeRow(palette, '\x1b[38;2;0;128;0mA\x1b[39mB', 3), 3);
  try {
    const line = vt.buffer.active.getLine(0)!;
    assert.equal(line.getCell(0)!.getFgColor(), 0x008000);
    assert.equal(line.getCell(1)!.getFgColor(), rgb(palette.colors.foreground));
    assert.ok(line.getCell(2)!.isBgDefault());
  } finally {
    vt.dispose();
  }
});

test('inline backgrounds survive foreground and attribute resets but not background resets or padding', async () => {
  const palette = theme('gruvbox');
  const text =
    '\x1b[48;2;0;128;0;1mA\x1b[39mB\x1b[22mC\x1b[49mD' + '\x1b[48;5;0mE\x1b[0;4mF\x1b[24mG\x1b[48;2;0;0;128mH';
  const vt = await parsedRow(paintThemeRow(palette, text, 10), 10);
  try {
    const line = vt.buffer.active.getLine(0)!;
    assert.equal(line.translateToString(false).trimEnd(), 'ABCDEFGH');
    for (const column of [0, 1, 2]) {
      assert.ok(line.getCell(column)!.isBgRGB());
      assert.equal(line.getCell(column)!.getBgColor(), 0x008000);
    }
    assert.ok(line.getCell(0)!.isBold());
    assert.ok(line.getCell(1)!.isBold());
    assert.ok(!line.getCell(2)!.isBold());
    assert.ok(line.getCell(3)!.isBgDefault());
    assert.ok(line.getCell(4)!.isBgPalette());
    assert.equal(line.getCell(4)!.getBgColor(), 0);
    assert.ok(line.getCell(5)!.isBgDefault());
    assert.ok(line.getCell(5)!.isUnderline());
    assert.ok(!line.getCell(6)!.isUnderline());
    assert.ok(line.getCell(6)!.isBgDefault());
    assert.equal(line.getCell(7)!.getBgColor(), 0x000080);
    for (const column of [8, 9]) {
      assert.ok(line.getCell(column)!.isBgDefault());
      assert.ok(!line.getCell(column)!.isBold());
      assert.ok(!line.getCell(column)!.isUnderline());
    }
    for (let column = 0; column < 10; column++) {
      assert.equal(line.getCell(column)!.getFgColor(), rgb(palette.colors.foreground));
    }
  } finally {
    vt.dispose();
  }
});

test('styled Unicode graphemes and zero-width cursor markers survive row painting', async () => {
  const palette = theme('gruvbox');
  const text = `e\u0301${CURSOR_MARKER}${colorText(palette, 'success', '界👩‍💻')}!`;
  const output = paintThemeRow(palette, text, 10);
  assert.ok(output.includes(CURSOR_MARKER));
  assert.equal(visibleWidth(output), 10);
  assert.equal(stripTerminalSequences(output), 'e\u0301界👩‍💻!    ');
  const vt = await parsedRow(output, 10);
  try {
    assert.equal(vt.buffer.active.getLine(0)!.translateToString(false).trimEnd(), 'e\u0301界👩‍💻!');
  } finally {
    vt.dispose();
  }
});

test('truncation respects wide grapheme boundaries, styles and a cursor before the cut', async () => {
  const palette = theme('nord');
  const output = paintThemeRow(palette, `${CURSOR_MARKER}${colorText(palette, 'accent', 'A界🙂B')}`, 4);
  assert.ok(output.includes(CURSOR_MARKER));
  assert.equal(visibleWidth(output), 4);
  assert.equal(stripTerminalSequences(output), 'A界 ');
  const vt = await parsedRow(output, 4);
  try {
    assert.equal(vt.buffer.active.getLine(0)!.translateToString(false).trimEnd(), 'A界');
  } finally {
    vt.dispose();
  }
});

test('controlled spans color only their text and return following content to the base foreground', async () => {
  const palette = theme('dracula');
  const roles: ThemeRole[] = ['foreground', 'muted', 'accent', 'success', 'warning', 'error', 'border'];
  const output = paintThemeRow(palette, roles.map((role) => colorText(palette, role, 'X') + '.').join(''), 14);
  const vt = await parsedRow(output, 14);
  try {
    const line = vt.buffer.active.getLine(0)!;
    for (const [index, role] of roles.entries()) {
      assert.equal(line.getCell(index * 2)!.getFgColor(), rgb(palette.colors[role]));
      assert.equal(line.getCell(index * 2 + 1)!.getFgColor(), rgb(palette.colors.foreground));
    }
  } finally {
    vt.dispose();
  }
});

test('painting is local SGR styling rather than terminal-global palette mutation', () => {
  for (const id of THEME_IDS) {
    const palette = theme(id);
    const output = paintThemeRow(palette, colorText(palette, 'accent', 'OMS'), 8);
    assert.ok(!output.includes('\x1b]'), 'renderer emitted an OSC command');
    assert.ok(!output.includes('\x9d'), 'renderer emitted a C1 OSC command');
    assert.ok(output.endsWith('\x1b[0m'), 'row must reset attributes when complete');
    assert.equal(visibleWidth(paintThemeRow(palette, 'unprinted', 0)), 0);
  }
});

test('unknown names, aliases and inherited object keys are not usable themes', () => {
  for (const name of [
    '',
    'unknown',
    'Gruvbox',
    ' gruvbox',
    'gruvbox ',
    'mocha',
    'tokyonight',
    'rosepine',
    'constructor',
    '__proto__',
    'toString',
  ]) {
    assert.equal(getTheme(name), undefined, name);
  }
  for (const id of THEME_IDS) assert.equal(theme(id).id, id);
});

test('a painted row cannot contain physical newlines or carriage returns', () => {
  const palette = theme('gruvbox');
  for (const text of ['one\ntwo', 'one\rtwo', 'one\r\ntwo']) {
    assert.throws(() => paintThemeRow(palette, text, 20), /row|newline|line|carriage/i);
  }
});
