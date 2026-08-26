#!/usr/bin/env python3
"""Generates the macOS menu bar template icons for Runbar.

Draws a simple 3-node "flow/run" glyph shared across all three tray states
(idle / alert / error), differing only by a small badge in the bottom-right
corner. All icons are template images: pure black (#000000) ink with an
antialiased alpha channel, no other colors, per Apple's NSImage template
image rules (macOS recolors black->current appearance automatically).

Output: resources/icons/{iconTemplate,iconTemplate-alert,iconTemplate-error}
        .png and their @2x variants (22x22 / 44x44 px).

Re-running this script regenerates all 6 files deterministically (idempotent).
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
OUT_DIR = os.path.join(REPO_ROOT, "resources", "icons")

# Render at 4x supersampling then box-downsample for smooth antialiased edges.
SUPERSAMPLE = 4
BASE_SIZE = 22  # points; macOS menu bar icon size
INK = (0, 0, 0, 255)


def _canvas(size: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def _draw_base_glyph(draw: ImageDraw.ImageDraw, s: int, *, badged: bool) -> None:
    """Draws a 3-node connected-graph 'flow/run' glyph, outline style.

    Coordinates are expressed as fractions of the supersampled canvas size
    `s`, so the same routine works at any supersample factor.

    When `badged` is True the whole glyph is shrunk and shifted toward the
    top-left, leaving the bottom-right quadrant clear for a status badge so
    it never overlaps or merges with the base silhouette.
    """
    if badged:
        # Same shape, scaled down and re-centered into the top-left ~70% of
        # the canvas so a badge fits cleanly in the freed bottom-right corner.
        node_positions = [
            (0.20, 0.58),  # bottom-left
            (0.40, 0.22),  # top-middle
            (0.60, 0.58),  # bottom-right
        ]
        scale = 0.82
    else:
        node_positions = [
            (0.28, 0.70),  # bottom-left
            (0.50, 0.30),  # top-middle
            (0.72, 0.70),  # bottom-right
        ]
        scale = 1.0

    node_radius = 0.095 * s * scale
    line_width = max(1, round(0.075 * s * scale))

    pts = [(x * s, y * s) for x, y in node_positions]

    # Connecting lines first (so node fills sit cleanly on top).
    draw.line([pts[0], pts[1]], fill=INK, width=line_width, joint="curve")
    draw.line([pts[1], pts[2]], fill=INK, width=line_width, joint="curve")

    # Nodes: outline circles (hollow) so the glyph reads as a graph, not a
    # blob, and stays visually light at 22px.
    outline_width = max(1, round(0.055 * s * scale))
    for cx, cy in pts:
        bbox = (cx - node_radius, cy - node_radius, cx + node_radius, cy + node_radius)
        draw.ellipse(bbox, outline=INK, width=outline_width)

    # Fill the middle (top) node solid to mark it as the "active" node in the
    # run path — a small asymmetry that keeps the glyph from looking like a
    # generic triangle.
    cx, cy = pts[1]
    inner = node_radius * 0.5
    draw.ellipse((cx - inner, cy - inner, cx + inner, cy + inner), fill=INK)


def _draw_alert_badge(draw: ImageDraw.ImageDraw, s: int) -> None:
    """Small filled solid dot badge, bottom-right corner: pending failures."""
    cx, cy = 0.80 * s, 0.80 * s
    r = 0.145 * s
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=INK)


def _draw_error_badge(draw: ImageDraw.ImageDraw, s: int) -> None:
    """Small '!' badge, bottom-right corner: connection error.

    Visually distinct from the alert dot (a stem + separate small dot,
    inside a hollow ring) rather than a single filled circle.
    """
    cx, cy = 0.80 * s, 0.80 * s
    r = 0.145 * s
    outline_width = max(1, round(0.045 * s))
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=INK, width=outline_width)

    stem_width = max(1, round(0.045 * s))
    stem_top = cy - r * 0.55
    stem_bottom = cy + r * 0.05
    draw.line([(cx, stem_top), (cx, stem_bottom)], fill=INK, width=stem_width)

    dot_r = 0.03 * s
    dot_cy = cy + r * 0.45
    draw.ellipse((cx - dot_r, dot_cy - dot_r, cx + dot_r, dot_cy + dot_r), fill=INK)


def _render(size_pt: int, status: str) -> Image.Image:
    s = size_pt * SUPERSAMPLE
    img, draw = _canvas(s)

    badged = status in ("alert", "error")
    _draw_base_glyph(draw, s, badged=badged)
    if status == "alert":
        _draw_alert_badge(draw, s)
    elif status == "error":
        _draw_error_badge(draw, s)

    # Box-downsample: antialiases alpha edges while keeping RGB pinned to 0
    # everywhere ink was drawn (Image.resize on RGBA interpolates alpha and
    # color channels independently; since every drawn pixel is pure black,
    # the resulting color channels stay 0 wherever alpha > 0, and undefined/0
    # elsewhere — so we hard-reset RGB to 0 for safety after resizing).
    resized = img.resize((size_pt, size_pt), Image.Resampling.LANCZOS)
    r, g, b, a = resized.split()
    zero = Image.new("L", resized.size, 0)
    flattened = Image.merge("RGBA", (zero, zero, zero, a))
    return flattened


def _write(img: Image.Image, filename: str) -> str:
    path = os.path.join(OUT_DIR, filename)
    img.save(path, format="PNG")
    return path


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)

    specs = [
        ("idle", "iconTemplate"),
        ("alert", "iconTemplate-alert"),
        ("error", "iconTemplate-error"),
    ]

    written = []
    for status, basename in specs:
        icon_1x = _render(BASE_SIZE, status)
        icon_2x = _render(BASE_SIZE * 2, status)
        written.append(_write(icon_1x, f"{basename}.png"))
        written.append(_write(icon_2x, f"{basename}@2x.png"))

    print("Generated:")
    for path in written:
        print(f"  {path}")


if __name__ == "__main__":
    main()
