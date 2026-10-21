"""Render Snapmark's app icon and menu-bar template icon as PNGs (stdlib only).

The glyph is the viewfinder-with-slash mark from the design, drawn on a
24-unit grid like the UI's SVG icons.
"""
import math, os, struct, sys, zlib

def arc(cx, cy, r, a0, a1, n=8):
    return [(cx + r * math.cos(a0 + (a1 - a0) * i / n), cy + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]

# Viewfinder corners (M3 8V5a2 2 0 0 1 2-2h3 …) plus the slash (m9 15 6-6).
H = math.pi
GLYPH = [
    [(3, 8)] + arc(5, 5, 2, H, 1.5 * H) + [(8, 3)],
    [(16, 3)] + arc(19, 5, 2, 1.5 * H, 2 * H) + [(21, 8)],
    [(21, 16)] + arc(19, 19, 2, 0, 0.5 * H) + [(16, 21)],
    [(8, 21)] + arc(5, 19, 2, 0.5 * H, H) + [(3, 16)],
    [(9, 15), (15, 9)],
]
SEGS = [(a, b) for poly in GLYPH for a, b in zip(poly, poly[1:])]

def seg_dist(px, py, a, b):
    ax, ay = a; bx, by = b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy or 1)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)

def glyph_hit(gx, gy, half):
    return any(seg_dist(gx, gy, a, b) <= half for a, b in SEGS)

def rrect_hit(x, y, size, r):
    qx = abs(x - size / 2) - (size / 2 - r)
    qy = abs(y - size / 2) - (size / 2 - r)
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) <= r

def write_png(path, w, h, rows):
    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(data)

def render(size, app_icon, ss=4):
    rows = []
    # macOS app icons sit inside a ~10% margin of the canvas.
    inset = size * 0.1 if app_icon else 0
    body = size - 2 * inset
    glyph_scale = body * 0.56 / 24 if app_icon else size / 24
    glyph_off = inset + (body - 24 * glyph_scale) / 2 if app_icon else 0
    half = (1.0 if app_icon else 1.05)  # stroke half-width in grid units
    for y in range(size):
        row = []
        for x in range(size):
            bg = fg = 0
            for sy in range(ss):
                for sx in range(ss):
                    px, py = x + (sx + 0.5) / ss, y + (sy + 0.5) / ss
                    gx, gy = (px - glyph_off) / glyph_scale, (py - glyph_off) / glyph_scale
                    hit = glyph_hit(gx, gy, half)
                    if app_icon:
                        if rrect_hit(px - inset, py - inset, body, body * 0.225):
                            bg += 1
                            fg += hit
                    else:
                        fg += hit
            n = ss * ss
            if app_icon:
                t = y / size  # vertical accent gradient
                r, g, b = int(255 - 20 * t), int(118 - 40 * t), int(72 - 28 * t)
                a_bg, a_fg = bg / n, fg / n
                if a_bg == 0:
                    row += [0, 0, 0, 0]
                    continue
                mix = a_fg / a_bg
                row += [int(r + (255 - r) * mix), int(g + (250 - g) * mix), int(b + (245 - b) * mix), int(255 * a_bg)]
            else:
                row += [0, 0, 0, int(255 * fg / n)]
        rows.append(row)
    return rows

def main(out):
    os.makedirs(out, exist_ok=True)
    write_png(os.path.join(out, "icon.png"), 512, 512, render(512, True, ss=3))
    write_png(os.path.join(out, "tray.png"), 18, 18, render(18, False))
    write_png(os.path.join(out, "tray@2x.png"), 36, 36, render(36, False))
    iconset = os.path.join(out, "icon.iconset")
    os.makedirs(iconset, exist_ok=True)
    for s in (16, 32, 128, 256, 512):
        write_png(os.path.join(iconset, f"icon_{s}x{s}.png"), s, s, render(s, True, ss=3))
        write_png(os.path.join(iconset, f"icon_{s}x{s}@2x.png"), 2 * s, 2 * s, render(2 * s, True, ss=2 if s >= 256 else 3))

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "icons")
