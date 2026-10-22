"""One-off script to generate the app icon set. Not shipped/used at runtime."""
from PIL import Image, ImageDraw
import math

BG = (20, 22, 26, 255)        # --color-bg-dark
ORANGE = (255, 92, 53, 255)   # --color-accent
LIME = (198, 255, 61, 255)    # --color-accent-live

def rounded_square(size, radius_ratio=0.22):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=BG)
    return img, d

def draw_loop(d, size):
    cx, cy = size / 2, size / 2 + size * 0.02
    rx, ry = size * 0.30, size * 0.24
    stroke = max(2, int(size * 0.055))

    points = []
    steps = 240
    for i in range(steps + 1):
        t = (i / steps) * 2 * math.pi
        wob = 1 + 0.10 * math.sin(3 * t + 0.6)
        x = cx + rx * wob * math.cos(t)
        y = cy + ry * wob * math.sin(t + 0.15)
        points.append((x, y))
    d.line(points, fill=ORANGE, width=stroke, joint="curve")

    start = points[0]
    dot_r = size * 0.055
    d.ellipse([start[0]-dot_r, start[1]-dot_r, start[0]+dot_r, start[1]+dot_r], fill=LIME)

def make_icon(size, path, maskable=False):
    ss = 4
    big = size * ss
    img, d = rounded_square(big, radius_ratio=0.0 if maskable else 0.22)
    draw_loop(d, big)
    img = img.resize((size, size), Image.LANCZOS)
    img.save(path)

sizes = {
    "icon-192.png": 192,
    "icon-512.png": 512,
    "icon-maskable-512.png": 512,
    "apple-touch-icon.png": 180,
    "favicon-32.png": 32,
}

for name, sz in sizes.items():
    make_icon(sz, name, maskable="maskable" in name)

print("done")
