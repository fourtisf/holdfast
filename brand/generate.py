"""Generates the Holdfast brand SVGs into brand/. Run from the repo root: python3 brand/generate.py (needs fonttools)."""
import os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

OUT = "brand"
MINT_A, MINT_B, INK, FG, BG = "#9ff5cc", "#3fd690", "#04170e", "#eceef4", "#07080c"
MINT = "#7ef0b8"

def glyph(color):
    s = f'fill="none" stroke="{color}" stroke-linecap="round" stroke-linejoin="round"'
    return (f'<path d="M21 22 L32 11 L43 22 M32 11 V35" {s} stroke-width="6"/>'
            f'<path d="M32 33 C22 33 17.5 40 19.5 48 M32 33 C42 33 46.5 40 44.5 48" {s} stroke-width="5.5"/>'
            f'<circle cx="32" cy="45" r="6.5" fill="{color}"/>'
            f'<path d="M15 55 H49" {s} stroke-width="4"/>')

def tile(gid="hf"):
    return (f'<defs><linearGradient id="{gid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{MINT_A}"/>'
            f'<stop offset="1" stop-color="{MINT_B}"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#{gid})"/>')

def svg(viewbox, body, w=None, h=None, title="Holdfast"):
    size = f' width="{w}" height="{h}"' if w else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox}"{size} role="img" aria-label="{title}"><title>{title}</title>{body}</svg>\n'

def wordmark(text, size, tracking=-0.015):
    """Outlined text: (svg path d, width, cap height) at font size `size`, baseline y=0."""
    font = TTFont("apps/web/node_modules/geist/dist/fonts/geist-sans/Geist-Bold.ttf")
    upm = font["head"].unitsPerEm
    cmap, gs, hmtx = font.getBestCmap(), font.getGlyphSet(), font["hmtx"]
    scale = size / upm
    x, parts = 0.0, []
    for ch in text:
        name = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, 0)))
        parts.append(pen.getCommands())
        x += hmtx[name][0] * scale + tracking * size
    cap = font["OS/2"].sCapHeight * scale
    return " ".join(parts), x - tracking * size, cap

def write(name, content):
    with open(os.path.join(OUT, name), "w") as f:
        f.write(content)

# 1. app icon / mark (color tile)
write("holdfast-mark.svg", svg("0 0 64 64", tile() + glyph(INK)))
# 2. glyph only, for dark and light backgrounds
GB = "11 6 42 53"
write("holdfast-glyph-mint.svg", svg(GB, glyph(MINT)))
write("holdfast-glyph-ink.svg", svg(GB, glyph(INK)))
# 3. horizontal logo: tile + wordmark, cap height = 44% of the tile, optically centred on it
d, tw, cap = wordmark("Holdfast", 1)
size = (64 * 0.44) / cap
d, tw, cap = wordmark("Holdfast", size)
gap = 17
baseline = 32 + cap / 2
W = round(64 + gap + tw + 1)
for variant, color in (("holdfast-logo.svg", FG), ("holdfast-logo-on-light.svg", BG)):
    body = tile() + glyph(INK) + f'<path transform="translate({64 + gap} {baseline:.2f})" d="{d}" fill="{color}"/>'
    write(variant, svg(f"0 0 {W} 64", body))
# 4. wordmark only
write("holdfast-wordmark.svg", svg(f"0 {-cap - 2:.2f} {tw + 1:.2f} {cap + 4:.2f}", f'<path d="{d}" fill="{FG}"/>'))
# 5. avatar: full-bleed (safe inside a circle crop)
k = 0.62  # glyph height / tile
avatar_glyph = f'<g transform="translate(32 33) scale({k * 64 / 49:.4f}) translate(-32 -32.5)">{glyph(INK)}</g>'
write("holdfast-avatar.svg", svg("0 0 64 64", f'<defs><linearGradient id="av" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{MINT_A}"/><stop offset="1" stop-color="{MINT_B}"/></linearGradient></defs><rect width="64" height="64" fill="url(#av)"/>' + avatar_glyph))
print("logo width", W, "font size", round(size, 2))
