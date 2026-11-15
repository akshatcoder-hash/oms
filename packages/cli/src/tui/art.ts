import { inflateSync } from 'node:zlib';

// Quadrant mosaic, ported from scripts/art/render5.py (byte-identical in truecolor). Every cell shows two
// colours: a block glyph picks which of its 2x2 sub-pixels take the foreground colour, the rest take the
// background colour. Both colours come from the picture, so the terminal's own background never shows.

export const ART_DIR = new URL('../../art/', import.meta.url);

/** How a picture's colours reach the terminal: 24-bit SGR, or the xterm 256 palette (cube and greys). */
export type ArtTier = 'truecolor' | '256';

/** RGB pixels, 3 bytes per pixel, row-major. */
export interface Pixels { width: number; height: number; data: Uint8Array }

/** Glyph for each foreground mask, mask = TL*1 + TR*2 + BL*4 + BR*8. */
const QUAD = [...' ▘▝▀▖▌▚▛▗▞▐▜▄▙▟█'];
/** The 7 ways to split 4 sub-pixels into two non-empty groups (a mask and its complement are one split). */
const SPLITS = [1, 2, 4, 8, 3, 5, 9];
/** Max RGB distance (0..1) of a sub-pixel from the cell mean below which the cell is one colour. */
const FLAT = 0.04;
/** Terminal cell width / height. */
const CELL_ASPECT = 0.5;

/** Python's round(): halves go to the even neighbour. The reference rounds this way, so the bytes match. */
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Pixels from a .ycc asset (scripts/art/build-assets.py): deflated full-range YCbCr, chroma at half size. */
export function decodeArt(bytes: Uint8Array, width: number, height: number): Pixels {
  const planes = inflateSync(bytes), cw = (width + 1) >> 1, ch = (height + 1) >> 1;
  if (planes.length !== width * height + 2 * cw * ch) throw new Error(`art asset is ${planes.length} bytes, expected ${width}x${height} YCbCr 4:2:0`);
  const data = new Uint8Array(width * height * 3), crOffset = width * height + cw * ch;
  const byte = (v: number) => v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = width * height + (y >> 1) * cw + (x >> 1);
      const l = planes[y * width + x]!, cb = planes[c]! - 128, cr = planes[c - width * height + crOffset]! - 128;
      const o = (y * width + x) * 3;
      data[o] = byte(l + 1.402 * cr);
      data[o + 1] = byte(l - 0.344136 * cb - 0.714136 * cr);
      data[o + 2] = byte(l + 1.772 * cb);
    }
  }
  return { width, height, data };
}

/** Rows that keep the picture's aspect at `cols` columns. */
export function artRows(cols: number, pixels: Pick<Pixels, 'width' | 'height'>): number {
  return Math.max(1, roundHalfEven(cols * pixels.height / pixels.width * CELL_ASPECT));
}

/** Area-average to tw x th samples of RGB 0..1, in the reference's exact float order (summed-area table). */
function downsample({ width: w, height: h, data }: Pixels, tw: number, th: number): Float64Array {
  const W1 = w + 1, sat = new Float64Array((h + 1) * W1 * 3);
  for (let y = 0; y < h; y++) for (let i = 3; i < W1 * 3; i++) sat[(y + 1) * W1 * 3 + i] = sat[y * W1 * 3 + i]! + data[y * w * 3 + i - 3]! / 255;
  for (let y = 1; y <= h; y++) for (let i = 6; i < W1 * 3; i++) sat[y * W1 * 3 + i]! += sat[y * W1 * 3 + i - 3]!;
  const out = new Float64Array(tw * th * 3);
  for (let j = 0; j < th; j++) {
    const y0 = Math.floor(j * h / th), y1 = Math.max(Math.floor((j + 1) * h / th), y0 + 1);
    for (let i = 0; i < tw; i++) {
      const x0 = Math.floor(i * w / tw), x1 = Math.max(Math.floor((i + 1) * w / tw), x0 + 1), area = (y1 - y0) * (x1 - x0);
      for (let c = 0; c < 3; c++) {
        const at = (y: number, x: number) => sat[(y * W1 + x) * 3 + c]!;
        out[(j * tw + i) * 3 + c] = (at(y1, x1) - at(y0, x1) - at(y1, x0) + at(y0, x0)) / area;
      }
    }
  }
  return out;
}

/** A cell's choice: mask picks the sub-pixels drawn in `fg`; mask 0 is a flat cell, a space on `bg`. */
interface Cell<Colour> { mask: number; fg: Colour; bg: Colour }

/** Mean of samples `ks` (cell-local 0..3) of `q` into `out`, summed left to right like the reference. */
function groupMean(q: Float64Array, ks: readonly number[], out: Float64Array): Float64Array {
  out.fill(0);
  for (const k of ks) for (let c = 0; c < 3; c++) out[c]! += q[k * 3 + c]!;
  for (let c = 0; c < 3; c++) out[c]! /= ks.length;
  return out;
}

function sqDist(q: Float64Array, k: number, p: Float64Array, pk = 0): number {
  const d0 = q[k * 3]! - p[pk * 3]!, d1 = q[k * 3 + 1]! - p[pk * 3 + 1]!, d2 = q[k * 3 + 2]! - p[pk * 3 + 2]!;
  return d0 * d0 + d1 * d1 + d2 * d2;
}

const ALL = [0, 1, 2, 3];
const GROUPS = SPLITS.map(mask => [ALL.filter(k => mask >> k & 1), ALL.filter(k => !(mask >> k & 1))] as const);
const fa = new Float64Array(3), fb = new Float64Array(3);

/** render5's choice: flat when every sub-pixel is near the mean, else the split with the least RGB error. */
function truecolorCell(q: Float64Array, cell: Cell<Float64Array>): void {
  const mean = groupMean(q, ALL, fa);
  let spread = 0;
  for (const k of ALL) spread = Math.max(spread, Math.sqrt(sqDist(q, k, mean)));
  if (spread < FLAT) { cell.mask = 0; cell.bg.set(mean); return; }
  let bestErr = Infinity;
  GROUPS.forEach(([a, b], s) => {
    groupMean(q, a, fa); groupMean(q, b, fb);
    let ea = 0, eb = 0;
    for (const k of a) ea += sqDist(q, k, fa);
    for (const k of b) eb += sqDist(q, k, fb);
    if (ea + eb < bestErr) { bestErr = ea + eb; cell.mask = SPLITS[s]!; cell.fg.set(fa); cell.bg.set(fb); }
  });
}

const srgbToLinear = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
/** OKLab (Ottosson) of RGB 0..1, written to out[o..o+2]. */
function oklab(r: number, g: number, b: number, out: Float64Array, o: number): void {
  r = srgbToLinear(r); g = srgbToLinear(g); b = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[o] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  out[o + 1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
}

/** xterm colours 16..255 as RGB 0..255: the 6x6x6 cube, then 24 greys. 0..15 are left out: themes repaint them. */
const PALETTE_256: readonly (readonly [number, number, number])[] = [
  ...Array.from({ length: 216 }, (_, i) => [Math.floor(i / 36), Math.floor(i / 6) % 6, i % 6].map(v => v ? 55 + 40 * v : 0) as [number, number, number]),
  ...Array.from({ length: 24 }, (_, i) => [8 + 10 * i, 8 + 10 * i, 8 + 10 * i] as [number, number, number]),
];
const PALETTE_LAB = new Float64Array(PALETTE_256.length * 3);
PALETTE_256.forEach(([r, g, b], i) => oklab(r / 255, g / 255, b / 255, PALETTE_LAB, i * 3));
/** Nearest index per colour at 6 bits a channel (step 4/255, far below the palette's 10..40 spacing), filled lazily. */
const nearestMemo = new Int16Array(1 << 18).fill(-1);
const labScratch = new Float64Array(3);

/** The xterm index (16..255) perceptually nearest to RGB 0..1, by OKLab distance. */
export function nearest256(r: number, g: number, b: number): number {
  const key = (Math.round(r * 63) << 12) | (Math.round(g * 63) << 6) | Math.round(b * 63);
  if (nearestMemo[key]! < 0) {
    oklab((key >> 12) / 63, (key >> 6 & 63) / 63, (key & 63) / 63, labScratch, 0);
    let best = 0, bestErr = Infinity;
    for (let i = 0; i < PALETTE_256.length; i++) {
      const err = sqDist(labScratch, 0, PALETTE_LAB, i);
      if (err < bestErr) { bestErr = err; best = i; }
    }
    nearestMemo[key] = best;
  }
  return nearestMemo[key]! + 16;
}

const groupIndex = (q: Float64Array, ks: readonly number[]) => { groupMean(q, ks, fa); return nearest256(fa[0]!, fa[1]!, fa[2]!); };
/** OKLab error of samples `ks` shown as palette colour `index`. */
function paletteError(lab: Float64Array, ks: readonly number[], index: number): number {
  let sum = 0;
  for (const k of ks) sum += sqDist(lab, k, PALETTE_LAB, index - 16);
  return sum;
}

/**
 * The 256 choice: each candidate (flat, or one of the splits) is quantised first and scored by the OKLab
 * error of the real sub-pixels against the palette colours it would show, so a cell is always two clean
 * palette colours; a split whose halves land on one index becomes a flat cell.
 */
function paletteCell(q: Float64Array, lab: Float64Array, cell: Cell<number>): void {
  const flat = groupIndex(q, ALL);
  let bestErr = paletteError(lab, ALL, flat);
  cell.mask = 0; cell.bg = flat;
  GROUPS.forEach(([a, b], s) => {
    const ia = groupIndex(q, a), ib = groupIndex(q, b), err = paletteError(lab, a, ia) + paletteError(lab, b, ib);
    if (err < bestErr) { bestErr = err; cell.mask = ia === ib ? 0 : SPLITS[s]!; cell.fg = ia; cell.bg = ib; }
  });
}

const sgr = (v: Float64Array) => `${roundHalfEven(v[0]! * 255)};${roundHalfEven(v[1]! * 255)};${roundHalfEven(v[2]! * 255)}`;
/** render5 merges runs on (flat, colours rounded to 4 decimals); the same key keeps the bytes identical. */
function runKey(cell: Cell<Float64Array>, key: Float64Array): void {
  key[0] = cell.mask ? 0 : 1;
  for (let c = 0; c < 3; c++) {
    key[1 + c] = roundHalfEven(cell.bg[c]! * 1e4);
    key[4 + c] = cell.mask ? roundHalfEven(cell.fg[c]! * 1e4) : -1;
  }
}

/**
 * Pure: RGB pixels to `rows` lines of exactly `cols` cells. Every cell paints its own background, nothing
 * outside the picture is coloured, and each line ends with a reset.
 */
export function renderArt(pixels: Pixels, cols: number, rows: number, tier: ArtTier): string[] {
  const tw = cols * 2, S = downsample(pixels, tw, rows * 2);
  const q = new Float64Array(12), lab = new Float64Array(12), key = new Float64Array(7), lastKey = new Float64Array(7);
  const rgbCell: Cell<Float64Array> = { mask: 0, fg: new Float64Array(3), bg: new Float64Array(3) };
  const indexCell: Cell<number> = { mask: 0, fg: 0, bg: 0 };
  const lines: string[] = [];
  for (let y = 0; y < rows; y++) {
    let line = '', last = '';
    lastKey.fill(NaN);
    for (let x = 0; x < cols; x++) {
      for (const k of ALL) {
        const at = ((2 * y + (k >> 1)) * tw + 2 * x + (k & 1)) * 3;
        q[k * 3] = S[at]!; q[k * 3 + 1] = S[at + 1]!; q[k * 3 + 2] = S[at + 2]!;
        if (tier === '256') oklab(S[at]!, S[at + 1]!, S[at + 2]!, lab, k * 3);
      }
      if (tier === 'truecolor') {
        truecolorCell(q, rgbCell); runKey(rgbCell, key);
        if (!key.every((v, i) => v === lastKey[i])) {
          line += `\x1b[48;2;${sgr(rgbCell.bg)}m` + (rgbCell.mask ? `\x1b[38;2;${sgr(rgbCell.fg)}m` : '');
          lastKey.set(key);
        }
        line += QUAD[rgbCell.mask];
      } else {
        paletteCell(q, lab, indexCell);
        const code = `\x1b[48;5;${indexCell.bg}m` + (indexCell.mask ? `\x1b[38;5;${indexCell.fg}m` : '');
        line += (code === last ? '' : code) + QUAD[indexCell.mask];
        last = code;
      }
    }
    lines.push(line + '\x1b[0m');
  }
  return lines;
}
