"""OMS startup art: quadrant mosaic renderer (reference implementation).

Every terminal cell shows two colours: a block-element glyph (quadrants, halves, full) picks which of the
cell's 2x2 sub-pixels get the foreground colour, the rest get the background colour.  Both colours are
area averages of the picture, so every cell is the right colour and edges follow the picture instead of
a font.  Nothing here depends on a font at runtime; the only table is the 16-entry quadrant alphabet.

Usage:
  render5.py IMG l,t,r,b COLS OUT.ans [--rows R] [--png OUT.png] [--bg r,g,b]
"""
import argparse
import subprocess
import sys

import numpy as np
from PIL import Image

# index = TL*1 + TR*2 + BL*4 + BR*8  ->  which sub-pixels are drawn in the foreground colour
QUAD = " ▘▝▀▖▌▚▛▗▞▐▜▄▙▟█"
# the 7 ways to split 4 sub-pixels into two non-empty groups (a mask and its complement are the same split)
SPLITS = (1, 2, 4, 8, 3, 5, 9)
FLAT = 0.04          # max RGB distance (0..1) of a sub-pixel from the cell mean below which the cell is one colour
CELL_ASPECT = 0.5    # terminal cell width / height


def rows_for(cols, img_w, img_h):
    """Rows that keep the picture's aspect at `cols` columns on 1:2 cells."""
    return max(1, round(cols * img_h / img_w * CELL_ASPECT))


def downsample(pixels, img_w, img_h, tw, th):
    """Area-average the picture to tw x th samples, values 0..1, shape (th, tw, 3)."""
    raw = np.frombuffer(pixels, np.uint8) if isinstance(pixels, (bytes, bytearray)) else np.asarray(pixels, np.uint8)
    src = raw.astype(np.float64).reshape(img_h, img_w, 3) / 255.0
    xs = (np.arange(tw + 1) * img_w) // tw
    ys = (np.arange(th + 1) * img_h) // th
    sat = np.zeros((img_h + 1, img_w + 1, 3))
    sat[1:, 1:] = src.cumsum(0).cumsum(1)
    out = np.empty((th, tw, 3))
    for j in range(th):
        y0, y1 = ys[j], max(ys[j + 1], ys[j] + 1)
        for i in range(tw):
            x0, x1 = xs[i], max(xs[i + 1], xs[i] + 1)
            total = sat[y1, x1] - sat[y0, x1] - sat[y1, x0] + sat[y0, x0]
            out[j, i] = total / ((y1 - y0) * (x1 - x0))
    return out


def sgr(fg, bg):
    s = "\x1b[48;2;%d;%d;%dm" % tuple(int(round(v * 255)) for v in bg)
    if fg is not None:
        s += "\x1b[38;2;%d;%d;%dm" % tuple(int(round(v * 255)) for v in fg)
    return s


def render(pixels, img_w, img_h, cols, rows, terminal_bg=None):
    """Pure function: RGB pixels (flat, row-major, 3 bytes per pixel) -> `rows` strings of `cols` cells.
    `terminal_bg` is unused: every cell inside the picture paints its own background."""
    S = downsample(pixels, img_w, img_h, cols * 2, rows * 2)
    lines = []
    for y in range(rows):
        parts, last = [], None
        for x in range(cols):
            q = [S[2 * y, 2 * x], S[2 * y, 2 * x + 1], S[2 * y + 1, 2 * x], S[2 * y + 1, 2 * x + 1]]  # TL TR BL BR
            mean = (q[0] + q[1] + q[2] + q[3]) / 4
            if max(np.sqrt(((p - mean) ** 2).sum()) for p in q) < FLAT:
                code, fg, bg = 0, None, mean
            else:
                best = None
                for mask in SPLITS:
                    a = [p for k, p in enumerate(q) if mask >> k & 1]
                    b = [p for k, p in enumerate(q) if not mask >> k & 1]
                    fa, fb = sum(a) / len(a), sum(b) / len(b)
                    err = sum(((p - fa) ** 2).sum() for p in a) + sum(((p - fb) ** 2).sum() for p in b)
                    if best is None or err < best[0]:
                        best = (err, mask, fa, fb)
                _, code, fg, bg = best
            key = (code == 0, tuple(np.round(bg, 4)), None if fg is None else tuple(np.round(fg, 4)))
            if key != last:
                parts.append(sgr(fg, bg))
                last = key
            parts.append(QUAD[code])
        lines.append("".join(parts) + "\x1b[0m")
    return lines


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("img"); ap.add_argument("crop"); ap.add_argument("cols", type=int); ap.add_argument("out")
    ap.add_argument("--rows", type=int, default=0)
    ap.add_argument("--png", default="")
    ap.add_argument("--bg", default="29,32,33")
    a = ap.parse_args()
    im = Image.open(a.img).convert("RGB").crop(tuple(int(v) for v in a.crop.split(",")))
    rows = a.rows or rows_for(a.cols, im.width, im.height)
    lines = render(im.tobytes(), im.width, im.height, a.cols, rows)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(a.out, f"{a.cols}x{rows}")
    if a.png:
        here = __file__.rsplit("/", 2)[0]
        subprocess.run([sys.executable, "-I", here + "/ans2png.py", a.out, a.png, a.bg], check=True)
