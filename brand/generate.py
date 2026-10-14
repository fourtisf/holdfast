"""Generates the Moatpad brand SVGs into brand/ and the web app's copies.

Run from the repo root: pip install fonttools && python3 brand/generate.py

The mark: an obsidian coin bearing a gold castle M (its pillars end in battlements) inside a gold ring,
the moat. The 2D mark follows the 3D renders in brand/3d (same castle-M geometry).
"""
import os
import shutil

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

OUT = "brand"
WEB_PUBLIC = "apps/web/public/brand"
FONT = "brand/fonts/Cinzel-SemiBold.woff"
INK, PAPER = "#15110a", "#f3efe4"

# castle M on a unit grid (x right, y up), the same polygon as brand/3d/src/scene.html
W, TOP, ND = 0.11, 0.45, 0.11
CASTLE_M = [(-0.56, -0.45), (-0.56, TOP), (-0.56 + W, TOP), (-0.56 + W, TOP - ND), (-0.56 + 2 * W, TOP - ND), (-0.56 + 2 * W, TOP),
            (-0.23, TOP), (0, 0.06), (0.23, TOP), (0.56 - 2 * W, TOP), (0.56 - 2 * W, TOP - ND), (0.56 - W, TOP - ND), (0.56 - W, TOP),
            (0.56, TOP), (0.56, -0.45), (0.23, -0.45), (0.23, -0.02), (0, -0.36), (-0.23, -0.02), (-0.23, -0.45)]

DEFS = """<defs>
<linearGradient id="mp-ring" x1="0.15" y1="0" x2="0.85" y2="1"><stop offset="0" stop-color="#fff0c2"/><stop offset="0.3" stop-color="#e7bd62"/><stop offset="0.62" stop-color="#9d7126"/><stop offset="0.85" stop-color="#e3b85d"/><stop offset="1" stop-color="#f6dc95"/></linearGradient>
<linearGradient id="mp-gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff1c6"/><stop offset="0.5" stop-color="#e8bc5b"/><stop offset="1" stop-color="#a97b2a"/></linearGradient>
<radialGradient id="mp-disc" cx="0.38" cy="0.3" r="0.8"><stop offset="0" stop-color="#3b3e45"/><stop offset="0.55" stop-color="#121418"/><stop offset="1" stop-color="#040506"/></radialGradient>
<linearGradient id="mp-word" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbe8b4"/><stop offset="1" stop-color="#c99a3e"/></linearGradient>
<linearGradient id="mp-tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#17181c"/><stop offset="1" stop-color="#050607"/></linearGradient>
</defs>"""


def castle_points(cx, cy, scale):
    return " ".join(f"{cx + x * scale:.2f},{cy - y * scale:.2f}" for x, y in CASTLE_M)


def mark(cx=50, cy=50, small=False):
    """The coin in a 100-unit box centred on (cx, cy)."""
    ring_w, disc_r, m_scale = (6.5, 35.5, 41) if small else (5, 36.5, 37)
    body = (f'<circle cx="{cx}" cy="{cy}" r="{47.5 - ring_w / 2:.2f}" fill="none" stroke="url(#mp-ring)" stroke-width="{ring_w}"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{disc_r}" fill="url(#mp-disc)"/>')
    if not small:
        # rim light and an embossed shadow under the castle
        body += (f'<circle cx="{cx}" cy="{cy}" r="{disc_r - 0.8}" fill="none" stroke="#ffffff" stroke-opacity="0.09" stroke-width="1.2"/>'
                 f'<polygon points="{castle_points(cx + 0.9, cy + 2.6, m_scale)}" fill="#000" fill-opacity="0.5"/>')
    return body + f'<polygon points="{castle_points(cx, cy + 1.5, m_scale)}" fill="url(#mp-gold)"/>'


def svg(viewbox, body, title="Moatpad"):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox}" role="img" aria-label="{title}"><title>{title}</title>{DEFS}{body}</svg>\n'


def wordmark(text="MOATPAD", cap_height=1.0, tracking=0.16):
    font = TTFont(FONT)
    upm = font["head"].unitsPerEm
    gs, cmap, hmtx = font.getGlyphSet(), font.getBestCmap(), font["hmtx"]
    bp = BoundsPen(gs)
    gs[cmap[ord("H")]].draw(bp)
    cap = bp.bounds[3]
    size = cap_height * upm / cap
    k = size / upm
    x, parts = 0.0, []
    for i, ch in enumerate(text):
        g = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[g].draw(TransformPen(pen, (k, 0, 0, -k, x, 0)))
        parts.append(pen.getCommands())
        x += hmtx[g][0] * k + (tracking * size if i < len(text) - 1 else 0)
    first = BoundsPen(gs)
    gs[cmap[ord(text[0])]].draw(first)
    return " ".join(parts), x, first.bounds[0] * k


def write(name, content):
    with open(os.path.join(OUT, name), "w") as f:
        f.write(content)


def main():
    for old in os.listdir(OUT):
        if old.endswith(".svg"):
            os.remove(os.path.join(OUT, old))

    write("moatpad-mark.svg", svg("2 2 96 96", mark()))
    write("moatpad-favicon.svg", svg("0 0 100 100", '<rect width="100" height="100" rx="22" fill="url(#mp-tile)"/>' + mark(small=True).replace('cx="50" cy="50"', 'cx="50" cy="50"')))
    write("moatpad-mark-small.svg", svg("2 2 96 96", mark(small=True)))

    # horizontal lockups: coin height 96, wordmark cap height 34% of it, centred on the coin
    cap = 0.34 * 96
    d, w, lsb = wordmark(cap_height=cap)
    gap = 26
    text_x = 98 + gap - lsb
    baseline = 50 + cap / 2
    width = 96 + gap + (w - lsb) + 2
    vb = f"2 2 {width:.2f} 96"
    write("moatpad-logo.svg", svg(vb, mark() + f'<path transform="translate({text_x:.2f} {baseline:.2f})" d="{d}" fill="url(#mp-word)"/>'))
    write("moatpad-logo-on-light.svg", svg(vb, mark() + f'<path transform="translate({text_x:.2f} {baseline:.2f})" d="{d}" fill="{INK}"/>'))

    # stacked
    cap_s = 0.24 * 96
    d, w, lsb = wordmark(cap_height=cap_s)
    tw = w - lsb
    full = max(tw, 96)
    gap_s = 26
    base_s = 98 + gap_s + cap_s
    write("moatpad-logo-stacked.svg", svg(f"{50 - full / 2:.2f} 2 {full:.2f} {96 + gap_s + cap_s + 2:.2f}",
                                          mark() + f'<path transform="translate({50 - tw / 2 - lsb:.2f} {base_s:.2f})" d="{d}" fill="url(#mp-word)"/>'))

    # wordmark alone
    d, w, lsb = wordmark(cap_height=40)
    for name, fill in (("moatpad-wordmark.svg", "url(#mp-word)"), ("moatpad-wordmark-on-light.svg", INK)):
        write(name, svg(f"{lsb - 2:.2f} -42 {w - lsb + 4:.2f} 44", f'<path d="{d}" fill="{fill}"/>', "MOATPAD"))

    os.makedirs(WEB_PUBLIC, exist_ok=True)
    for f in ("moatpad-logo.svg", "moatpad-mark.svg"):
        shutil.copy(os.path.join(OUT, f), os.path.join(WEB_PUBLIC, f))
    shutil.copy(os.path.join(OUT, "moatpad-favicon.svg"), "apps/web/src/app/icon.svg")


if __name__ == "__main__":
    main()
    print("wrote", sorted(f for f in os.listdir(OUT) if f.endswith(".svg")))
