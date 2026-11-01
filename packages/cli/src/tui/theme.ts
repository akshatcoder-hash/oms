import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export const THEME_IDS = ['gruvbox', 'catppuccin', 'tokyo-night', 'nord', 'dracula', 'rose-pine'] as const;
export type OmsThemeId = typeof THEME_IDS[number];
export const DEFAULT_THEME_ID: OmsThemeId = 'gruvbox';
export type ThemeRole = 'foreground' | 'muted' | 'accent' | 'success' | 'warning' | 'error' | 'border';
export interface OmsTheme {
  id: OmsThemeId;
  name: string;
  background: string;
  surface: string;
  colors: Readonly<Record<ThemeRole, string>>;
}

/* Palette data only; no upstream editor implementation is copied.
 * Gruvbox: Pavel Pertsev <morhetz@gmail.com>, MIT/X11.
 * https://github.com/morhetz/gruvbox/blob/ef8864bb42bf244f0295d1c5a403b27e3d139695/colors/gruvbox.vim
 * Catppuccin Mocha: Copyright (c) 2021 Catppuccin, MIT.
 * https://github.com/catppuccin/palette/blob/07d02aa110ef9eb7e7427afca5c73ba9cf7f8ebd/palette.json
 * Tokyo Night (night inherits storm): folke/tokyonight.nvim, Apache-2.0.
 * https://github.com/folke/tokyonight.nvim/tree/cdc07ac78467a233fd62c493de29a17e0cf2b2b6/lua/tokyonight/colors
 * Nord: Copyright (c) 2016-present Sven Greb <development@svengreb.de>, MIT.
 * https://github.com/nordtheme/nord/blob/1cef71605416a222e57225b544540ce0fcec18d4/src/swatches/nord.gpl
 * Dracula: Copyright (c) 2023 Dracula Theme, MIT. https://draculatheme.com/spec
 * Rosé Pine main: Copyright (c) mvllow, MIT.
 * https://github.com/rose-pine/rose-pine-palette/blob/92af52b465ab6e47437aca223c9b8d3009a2023b/dist/css/rose-pine.css
 * OMS maps original tokens to semantic roles; no blended or invented colors.
 * Low-contrast comment tokens are not used for text. Gruvbox orange and Nord
 * gold replace their low-contrast reds for errors; labels must convey status.
 * Distribution must retain the upstream MIT notices and Apache-2.0 license.
 */
const THEMES: Readonly<Record<OmsThemeId, OmsTheme>> = {
  gruvbox: {
    id: 'gruvbox', name: 'Gruvbox', background: '#282828', surface: '#3c3836',
    colors: { foreground: '#ebdbb2', muted: '#a89984', accent: '#8ec07c', success: '#b8bb26',
      warning: '#fabd2f', error: '#fe8019', border: '#665c54' },
  },
  catppuccin: {
    id: 'catppuccin', name: 'Catppuccin Mocha', background: '#1e1e2e', surface: '#313244',
    colors: { foreground: '#cdd6f4', muted: '#a6adc8', accent: '#89b4fa', success: '#a6e3a1',
      warning: '#f9e2af', error: '#f38ba8', border: '#585b70' },
  },
  'tokyo-night': {
    id: 'tokyo-night', name: 'Tokyo Night', background: '#1a1b26', surface: '#292e42',
    colors: { foreground: '#c0caf5', muted: '#a9b1d6', accent: '#7aa2f7', success: '#9ece6a',
      warning: '#e0af68', error: '#f7768e', border: '#414868' },
  },
  nord: {
    id: 'nord', name: 'Nord', background: '#2e3440', surface: '#3b4252',
    colors: { foreground: '#eceff4', muted: '#d8dee9', accent: '#88c0d0', success: '#a3be8c',
      warning: '#ebcb8b', error: '#ebcb8b', border: '#4c566a' },
  },
  dracula: {
    id: 'dracula', name: 'Dracula', background: '#282a36', surface: '#44475a',
    colors: { foreground: '#f8f8f2', muted: '#bd93f9', accent: '#8be9fd', success: '#50fa7b',
      warning: '#f1fa8c', error: '#ff5555', border: '#6272a4' },
  },
  'rose-pine': {
    id: 'rose-pine', name: 'Rosé Pine', background: '#191724', surface: '#1f1d2e',
    colors: { foreground: '#e0def4', muted: '#908caa', accent: '#c4a7e7', success: '#9ccfd8',
      warning: '#f6c177', error: '#eb6f92', border: '#524f67' },
  },
};

export function getTheme(name: string): OmsTheme | undefined {
  return Object.hasOwn(THEMES, name) ? THEMES[name as OmsThemeId] : undefined;
}

function truecolor(hex: string, target: 38 | 48): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${target};2;${value >>> 16};${(value >>> 8) & 255};${value & 255}`;
}

/** Controlled, already-sanitized text only. Row painting restores the base color. */
export function colorText(theme: OmsTheme, role: ThemeRole, text: string): string {
  return `\x1b[${truecolor(theme.colors[role], 38)}m${text}\x1b[39m`;
}

/** Restore row foreground defaults while leaving the terminal background default. */
function restoreRowColors(text: string, foreground: string): string {
  return text.replace(/\x1b\[([\d;:]*)m/g, (sequence: string, parameters: string) => {
    const values = parameters.split(';');
    let changed = false;
    for (let index = 0; index < values.length; index++) {
      const value = values[index]!;
      // Semicolon RGB/indexed payloads contain numbers (including zero), not SGR
      // instructions. Colon-form color payloads stay intact as a single value.
      if (value === '38' || value === '48' || value === '58') {
        const mode = values[index + 1];
        index += mode === '2' ? 4 : mode === '5' ? 2 : 0;
        continue;
      }
      if (value.includes(':')) continue;
      const code = Number(value);
      if (code === 0) values[index] = `0;${foreground};49`;
      else if (code === 39) values[index] = foreground;
      else continue;
      changed = true;
    }
    return changed ? `\x1b[${values.join(';')}m` : sequence;
  });
}

/**
 * Paint one trusted rendered row, never raw subprocess output. Public TUI width
 * helpers preserve grapheme boundaries, SGR spans and zero-width cursor markers.
 * These local SGR colors never alter the terminal's global palette/profile.
 */
export function paintThemeRow(theme: OmsTheme, text: string, width: number): string {
  if (/[\r\n]/.test(text)) throw new Error('A painted row cannot contain a newline or carriage return');
  if (!Number.isSafeInteger(width) || width < 0) throw new RangeError('Row width must be a nonnegative integer');
  const foreground = truecolor(theme.colors.foreground, 38);
  const base = `\x1b[0;${foreground};49m`;
  const row = truncateToWidth(text, width, '');
  const padding = ' '.repeat(Math.max(0, width - visibleWidth(row)));
  return base + restoreRowColors(row, foreground) + base + padding + '\x1b[0m';
}
