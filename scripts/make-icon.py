"""Render the compressor marketplace icon from the brand mark geometry.

Reproduces compressor-mark-for-dark-bg on the navy primary background
(#0E1530). Supersamples 16x then downscales with LANCZOS for crisp pill ends.
Writes assets/icon.png (128) and assets/icon-256.png. Run: python3 scripts/make-icon.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

ASSETS = Path(__file__).resolve().parent.parent / "assets"

SS = 16                      # supersample factor: render at 128*16 = 2048
SIZE = 128
R = SIZE * SS

NAVY = (14, 21, 48, 255)     # #0E1530
TEAL = (17, 197, 180, 255)   # #11C5B4
OFFW = (244, 246, 251, 255)  # #F4F6FB

# (x, y, w, h, fill) in the brand's 1024 coordinate space
BARS = [
    (148.0, 369.2, 728.0, 61.6, TEAL),
    (271.2, 481.2, 481.6, 61.6, TEAL),
    (377.6, 593.2, 268.8, 61.6, OFFW),
]


def render(background):
    img = Image.new("RGBA", (R, R), background)
    draw = ImageDraw.Draw(img)
    k = R / 1024.0
    for x, y, w, h, fill in BARS:
        x0, y0, x1, y1 = x * k, y * k, (x + w) * k, (y + h) * k
        draw.rounded_rectangle([x0, y0, x1, y1], radius=(h / 2) * k, fill=fill)
    return img.resize((SIZE, SIZE), Image.LANCZOS)


ASSETS.mkdir(exist_ok=True)
render(NAVY).save(ASSETS / "icon.png")
render(NAVY).resize((256, 256), Image.LANCZOS).save(ASSETS / "icon-256.png")
print(f"wrote {ASSETS / 'icon.png'} (128) and icon-256.png (256)")
