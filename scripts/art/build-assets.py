"""Crop the artwork out of each startup-screen mock-up and write packages/cli/art/.

Usage: build-assets.py SOURCE_DIR
Writes, per shipped picture, NN-slug.ycc (the mosaic's pixels) and NN-slug.jpg (the real picture for terminals with
Kitty graphics, converted to PNG at runtime by pi), and index.json. Offline; needs Pillow.
crops.json (next to this script) holds each picture's artwork rectangle [left, top, right, bottom] in the mock-up:
artwork only, no frame, title or prompt text. Every edge was checked zoomed in.
A .ycc file is pre-decoded pixels, so the CLI needs no image decoder: zlib-deflated full-range YCbCr
(JPEG's formula), the Y plane at width x height, then Cb and Cr planes at half size (rounded up).
"""
import json
import sys
import zlib
from pathlib import Path

from PIL import Image

WIDTH = 640  # 3 sub-pixels per cell: full detail up to 213 columns
# The JPEGs at 1200 px, quality 75 look as clean as 1024 px at 85, and the folder stays under its 2.5 MB budget.
IMAGE_WIDTH, IMAGE_QUALITY = 1200, 75
# The manifest drops the dash and the place-name capitals; these are the intended titles.
TITLES = {59: "After the monsoon — Chiang Mai", 62: "A city in the sunlight — Victorian"}
OUT = Path(__file__).resolve().parents[2] / "packages" / "cli" / "art"

src = Path(sys.argv[1])
crops = json.loads((Path(__file__).parent / "crops.json").read_text())
manifest = json.loads((src / "manifest.json").read_text())
OUT.mkdir(parents=True, exist_ok=True)
index = []
for item in manifest:
    name = Path(item["file"]).name
    if name not in crops:
        continue
    art = Image.open(src / name).convert("RGB").crop(tuple(crops[name]))
    image = Path(name).with_suffix(".jpg").name
    art.resize((IMAGE_WIDTH, round(art.height * IMAGE_WIDTH / art.width)), Image.LANCZOS).save(
        OUT / image, quality=IMAGE_QUALITY, optimize=True)
    art = art.resize((WIDTH, round(art.height * WIDTH / art.width)), Image.LANCZOS)
    file = Path(name).with_suffix(".ycc").name
    y, cb, cr = art.convert("YCbCr").split()
    half = ((art.width + 1) // 2, (art.height + 1) // 2)
    planes = y.tobytes() + cb.resize(half, Image.BOX).tobytes() + cr.resize(half, Image.BOX).tobytes()
    (OUT / file).write_bytes(zlib.compress(planes, 9))
    number, title = int(item["number"]), item["title"]
    index.append({"number": number, "title": TITLES.get(number, title[0].upper() + title[1:]),
                  "file": file, "image": image, "width": art.width, "height": art.height})
(OUT / "index.json").write_text(json.dumps(index, indent=2) + "\n")
print(f"{len(index)} pictures, {sum(f.stat().st_size for f in OUT.iterdir())} bytes")
