"""Generates the Holdfast brand SVGs into brand/.

Run from the repo root: pip install fonttools && python3 brand/generate.py

The mark is a monogram H built like a rampart: two pillars whose tops rise toward the centre and a chevron
crossbar pointing up. Walls that hold, a price that rises between them. Every diagonal shares one slope.
"""
import os
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

OUT = "brand"
FONT = "apps/web/node_modules/geist/dist/fonts/geist-sans/Geist-SemiBold.ttf"
SLOPE = 0.8

PAPER, NIGHT = "#eef2ef", "#07080c"

DEFS = """<defs>
<linearGradient id="hf-lit" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#d4ffe9"/><stop offset="0.42" stop-color="#5fe8a8"/><stop offset="1" stop-color="#0c8653"/></linearGradient>
<linearGradient id="hf-shade" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#1fae72"/><stop offset="1" stop-color="#06402a"/></linearGradient>
<linearGradient id="hf-deep-lit" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#18b071"/><stop offset="1" stop-color="#0a5a39"/></linearGradient>
<linearGradient id="hf-deep-shade" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#0b6d47"/><stop offset="1" stop-color="#03281a"/></linearGradient>
<linearGradient id="hf-tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#132a20"/><stop offset="1" stop-color="#04090a"/></linearGradient>
<radialGradient id="hf-glow" cx="0.5" cy="0.42" r="0.55"><stop offset="0" stop-color="#5fe8a8" stop-opacity="0.22"/><stop offset="1" stop-color="#5fe8a8" stop-opacity="0"/></radialGradient>
</defs>"""

# ---- geometry (100 × 100 grid; the mark spans x 14..86, y 12..88) ----------------------------------
TOP, BASE, X0, PW, GAP, Y0, T = 12, 88, 14, 20, 32, 54, 17
XL1, XR0 = X0 + PW, X0 + PW + GAP
XR1 = XR0 + PW
CAP, RISE = PW * SLOPE, GAP / 2 * SLOPE
LM, RM = X0 + PW / 2, XR0 + PW / 2
MARK_BOX = (14, 12, 72, 76)


def poly(pts, fill, extra=""):
    return f'<polygon points="{" ".join(f"{x:g},{y:g}" for x, y in pts)}" fill="{fill}"{extra}/>'


def mark_faces():
    """Outer faces lit, inner faces in shade: the pillars read as folded metal."""
    lit = [
        [(X0, TOP + CAP), (LM, TOP + CAP / 2), (LM, BASE), (X0, BASE)],
        [(RM, TOP + CAP / 2), (XR1, TOP + CAP), (XR1, BASE), (RM, BASE)],
        [(XL1, Y0), (50, Y0 - RISE), (50, Y0 - RISE + T), (XL1, Y0 + T)],
    ]
    shade = [
        [(LM, TOP + CAP / 2), (XL1, TOP), (XL1, BASE), (LM, BASE)],
        [(XR0, TOP), (RM, TOP + CAP / 2), (RM, BASE), (XR0, BASE)],
        [(50, Y0 - RISE), (XR0, Y0), (XR0, Y0 + T), (50, Y0 - RISE + T)],
    ]
    return lit, shade


def mark(lit="url(#hf-lit)", shade="url(#hf-shade)"):
    l, s = mark_faces()
    return "".join(poly(p, lit) for p in l) + "".join(poly(p, shade) for p in s)


def mark_flat(fill):
    """Single-colour silhouette: favicons, mono uses."""
    left = [(X0, TOP + CAP), (XL1, TOP), (XL1, BASE), (X0, BASE)]
    right = [(XR0, TOP), (XR1, TOP + CAP), (XR1, BASE), (XR0, BASE)]
    chev = [(XL1, Y0), (50, Y0 - RISE), (XR0, Y0), (XR0, Y0 + T), (50, Y0 - RISE + T), (XL1, Y0 + T)]
    return poly(left, fill) + poly(right, fill) + poly(chev, fill)


def tile(inner, scale=0.8, radius=23):
    return (
        f'<rect width="100" height="100" rx="{radius}" fill="url(#hf-tile)"/><rect width="100" height="100" rx="{radius}" fill="url(#hf-glow)"/>'
        f'<rect x="0.6" y="0.6" width="98.8" height="98.8" rx="{radius - 0.6}" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="1.2"/>'
        f'<g transform="translate(50 50) scale({scale}) translate(-50 -50)">{inner}</g>'
    )


def svg(viewbox, body, title="Holdfast"):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox}" role="img" aria-label="{title}"><title>{title}</title>{DEFS}{body}</svg>\n'


# ---- wordmark: HOLDFAST, Geist SemiBold, tracked, outlined (no font needed) -----------------------
TRACKING = 0.16
KERN = {("F", "A"): -0.045, ("A", "S"): -0.012, ("A", "T"): -0.02}


def wordmark(text="HOLDFAST", cap_height=1.0):
    font = TTFont(FONT)
    upm, cap = font["head"].unitsPerEm, font["OS/2"].sCapHeight
    size = cap_height * upm / cap
    scale = size / upm
    cmap, glyphs, hmtx = font.getBestCmap(), font.getGlyphSet(), font["hmtx"]
    x, parts = 0.0, []
    for i, ch in enumerate(text):
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, 0)))
        parts.append(pen.getCommands())
        x += hmtx[name][0] * scale
        if i < len(text) - 1:
            x += (TRACKING + KERN.get((ch, text[i + 1]), 0)) * size
    lsb = font["hmtx"][cmap[ord(text[0])]][1] * scale
    return " ".join(parts), x, lsb


def write(name, content):
    with open(os.path.join(OUT, name), "w") as f:
        f.write(content)


def main():
    for old in os.listdir(OUT):
        if old.endswith(".svg"):
            os.remove(os.path.join(OUT, old))
    mb = " ".join(f"{v:g}" for v in MARK_BOX)

    write("holdfast-mark.svg", svg(mb, mark()))
    write("holdfast-mark-on-light.svg", svg(mb, mark("url(#hf-deep-lit)", "url(#hf-deep-shade)")))
    write("holdfast-mark-white.svg", svg(mb, mark_flat("#ffffff")))
    write("holdfast-mark-black.svg", svg(mb, mark_flat(NIGHT)))
    write("holdfast-icon.svg", svg("0 0 100 100", tile(mark())))
    # favicon: flat mark, larger in the tile, so it survives 16 px
    write("holdfast-favicon.svg", svg("0 0 100 100", tile(mark_flat("url(#hf-lit)"), scale=0.9)))
    # avatar: full-bleed square, mark inside the circle crop
    write("holdfast-avatar.svg", svg("0 0 100 100", tile(mark(), scale=0.66, radius=0)))

    # wordmark alone
    for name, color in (("holdfast-wordmark.svg", PAPER), ("holdfast-wordmark-on-light.svg", NIGHT)):
        d, w, lsb = wordmark(cap_height=40)
        write(name, svg(f"{lsb - 2:.2f} -42 {w - lsb + 4:.2f} 44", f'<path d="{d}" fill="{color}"/>', "HOLDFAST"))

    # horizontal lockup: mark height 76, cap height 40% of it, centred on the mark's optical middle
    mh = MARK_BOX[3]
    cap_h = 0.40 * mh
    gap = 0.36 * mh
    d, w, lsb = wordmark(cap_height=cap_h)
    baseline = MARK_BOX[1] + mh / 2 + cap_h / 2 + 1
    wx = MARK_BOX[0] + MARK_BOX[2] + gap - lsb
    width = MARK_BOX[2] + gap + (w - lsb)
    vb = f"{MARK_BOX[0]:g} {MARK_BOX[1]:g} {width:.2f} {mh:g}"
    for name, m, color in (
        ("holdfast-logo.svg", mark(), PAPER),
        ("holdfast-logo-on-light.svg", mark("url(#hf-deep-lit)", "url(#hf-deep-shade)"), NIGHT),
        ("holdfast-logo-white.svg", mark_flat("#ffffff"), "#ffffff"),
    ):
        write(name, svg(vb, m + f'<path transform="translate({wx:.2f} {baseline:.2f})" d="{d}" fill="{color}"/>'))

    # stacked lockup: mark above, wordmark centred below
    cap_s = 0.26 * mh
    d, w, lsb = wordmark(cap_height=cap_s)
    tw = w - lsb
    full_w = max(tw, MARK_BOX[2])
    gap_s = 0.30 * mh
    base_s = MARK_BOX[1] + mh + gap_s + cap_s
    x_text = 50 - tw / 2 - lsb
    vb_s = f"{50 - full_w / 2:.2f} {MARK_BOX[1]:g} {full_w:.2f} {mh + gap_s + cap_s:.2f}"
    write("holdfast-logo-stacked.svg", svg(vb_s, mark() + f'<path transform="translate({x_text:.2f} {base_s:.2f})" d="{d}" fill="{PAPER}"/>'))


if __name__ == "__main__":
    main()
    print("wrote", sorted(f for f in os.listdir(OUT) if f.endswith(".svg")))
