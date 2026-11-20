#!/usr/bin/env python3
"""Render the PWA PNG icons (same design as app/static/icons/icon.svg).

Pure stdlib, no Pillow needed:  python3 tools/gen_icons.py
"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "app" / "static" / "icons"
C1, C2 = (0x4C, 0x8D, 0xFF), (0x23, 0x46, 0xB8)
WHITE, SLOT = (255, 255, 255), (0x2A, 0x55, 0xCC)


def in_rrect(x, y, x0, y0, w, h, r):
    if not (x0 <= x <= x0 + w and y0 <= y <= y0 + h):
        return False
    cx = min(max(x, x0 + r), x0 + w - r)
    cy = min(max(y, y0 + r), y0 + h - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def shade(x, y, corner):
    """Colour at design coords (0..512), or None when transparent."""
    if corner and not in_rrect(x, y, 0, 0, 512, 512, 112):
        return None
    c = mix(C1, C2, min(max((x + y) / 1024, 0.0), 1.0))
    for top, op in ((116, 0.7), (208, 0.85), (300, 1.0)):
        if in_rrect(x, y, 136, top, 240, 76, 14):
            c = mix(c, WHITE, op)
            if in_rrect(x, y, 168, top + 30, 64, 16, 8):
                c = SLOT
    return c


def render(size, corner=True, scale=1.0, ss=3):
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc, n = [0.0, 0.0, 0.0, 0.0], ss * ss
            for sy in range(ss):
                for sx in range(ss):
                    # design coordinate, optionally shrunk around the centre
                    x = ((px + (sx + 0.5) / ss) / size * 512 - 256) / scale + 256
                    y = ((py + (sy + 0.5) / ss) / size * 512 - 256) / scale + 256
                    c = shade(x, y, corner)
                    if c is None and not corner:
                        c = mix(C1, C2, 0.5)
                    if c is not None:
                        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 1
            a = acc[3]
            if a:
                row += bytes([round(acc[0] / a), round(acc[1] / a), round(acc[2] / a), round(255 * a / n)])
            else:
                row += b"\0\0\0\0"
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")
    path.write_bytes(data)
    print("wrote", path)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    write_png(OUT / "icon-192.png", 192, render(192))
    write_png(OUT / "icon-512.png", 512, render(512, ss=2))
    # maskable: full-bleed background, artwork inside the 80% safe zone
    write_png(OUT / "icon-maskable-512.png", 512, render(512, corner=False, scale=0.8, ss=2))
    # iOS applies its own rounding; give it a full square
    write_png(OUT / "apple-touch-icon.png", 180, render(180, corner=False, scale=0.9))
