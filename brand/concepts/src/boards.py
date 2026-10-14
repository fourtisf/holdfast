import glob, os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
from marks import CONCEPTS, DEFS

FD = os.environ.get("FONTSOURCE_DIR", "/tmp/claude-0/-home-user-holdfast/da1b599f-10d5-56da-8a34-5669c3fd33a8/scratchpad/fonts")
OUT = "/home/user/holdfast/brand/concepts"

def font_file(name, weight):
    if name == "inter-display":
        return f"/usr/share/fonts/opentype/inter/InterDisplay-{ {900:'Black',700:'Bold',600:'SemiBold'}[weight] }.otf"
    return glob.glob(f"{FD}/fontsource-{name}-*/package/files/{name}-latin-{weight}-normal.woff")[0]

def wordmark(c, cap_h):
    f = TTFont(font_file(c["font"], c["weight"]))
    upm = f["head"].unitsPerEm
    cap = getattr(f["OS/2"], "sCapHeight", 0) or 0.7 * upm
    size = cap_h * upm / cap
    k = size / upm
    gs, cmap, hmtx = f.getGlyphSet(), f.getBestCmap(), f["hmtx"]
    x, parts = 0.0, []
    for i, ch in enumerate(c["text"]):
        g = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[g].draw(TransformPen(pen, (k, 0, 0, -k, x, 0)))
        parts.append(pen.getCommands())
        x += hmtx[g][0] * k + (c["track"] * size if i < len(c["text"]) - 1 else 0)
    bp = BoundsPen(gs)
    first = cmap[ord(c["text"][0])]
    gs[first].draw(bp)
    lsb = (bp.bounds[0] if bp.bounds else 0) * k
    return " ".join(parts), x - lsb, lsb

def body(c, theme):
    if c["key"] == "diamond":
        return c["fn"](c["dark"]).replace("{bg}", "#111318") if theme == "dark" else c["fn"](c["light"], False).replace("{bg}", "#f5f4f0")
    return c["fn"](c["dark"] if theme == "dark" else c["light"])

def mark_svg(c, size, theme="dark", tile=False, radius=22):
    t = f'<rect width="100" height="100" rx="{radius}" fill="{c["tile"]}"/>' if tile else ""
    b = c["fn"](c["dark"]).replace("{bg}", "#07080c") if (tile and c["key"] == "diamond") else body(c, theme)
    return f'<svg viewBox="0 0 100 100" width="{size}" height="{size}">{DEFS}{t}{b}</svg>'

def lockup(c, height, theme):
    color = "#eef0ec" if theme == "dark" else "#0b0c10"
    if c["key"] == "vault" and theme == "dark": color = "url(#gold)"
    if c["key"] == "kelp" and theme == "dark": color = "#efe6cf"
    cap = 100 * 0.30
    d, w, lsb = wordmark(c, cap)
    gap = 26
    W = 100 + gap + w
    return (f'<svg viewBox="0 0 {W:.1f} 100" height="{height}" width="{height * W / 100:.0f}">{DEFS}{body(c, theme)}'
            f'<path transform="translate({100 + gap - lsb:.2f} {50 + cap / 2:.2f})" d="{d}" fill="{color}"/></svg>')

CSS = "body{margin:0;font-family:sans-serif;color:#eef0ec}"

def board(i, c):
    return f'''<!doctype html><html><head><style>{CSS}
    .b{{width:1600px;height:1000px;box-sizing:border-box;padding:56px 64px;background:#0a0b0f;display:flex;flex-direction:column;gap:30px}}
    h1{{font:600 34px sans-serif;margin:0;letter-spacing:-.5px}} .n{{color:#5c6372;font:500 15px sans-serif;letter-spacing:.2em}}
    p{{font:400 19px/1.5 sans-serif;color:#9aa1b0;margin:6px 0 0;max-width:1100px}}
    .g{{display:flex;gap:28px;flex:1}} .hero{{width:470px;border-radius:28px;display:flex;align-items:center;justify-content:center;background:#111318;border:1px solid #1d2028}}
    .c{{flex:1;display:flex;flex-direction:column;gap:22px}} .card{{flex:1;border-radius:22px;display:flex;align-items:center;justify-content:center}}
    .d{{background:#111318;border:1px solid #1d2028}} .l{{background:#f5f4f0}} .row{{display:flex;gap:22px;flex:1}}
    </style></head><body><div class="b">
    <div><div class="n">CONCEPT {i + 1:02d}</div><h1>{c["name"]}</h1><p>{c["idea"]}</p></div>
    <div class="g"><div class="hero">{mark_svg(c, 330, tile=True)}</div>
      <div class="c"><div class="card d">{lockup(c, 116, "dark")}</div><div class="card l">{lockup(c, 116, "light")}</div>
        <div class="row"><div class="card d"><div style="border-radius:50%;overflow:hidden;width:120px;height:120px">{mark_svg(c, 120, tile=True, radius=0)}</div></div>
          <div class="card d" style="gap:20px">{mark_svg(c, 72, tile=True)}{mark_svg(c, 44, tile=True)}{mark_svg(c, 28, tile=True)}{mark_svg(c, 16, tile=True)}</div></div></div></div>
    </div></body></html>'''

def overview():
    cells = "".join(f'''<div class="cell"><div class="top">{mark_svg(c, 150, tile=True)}<div><div class="n">{i + 1:02d}</div><div class="t">{c["name"]}</div></div></div>
      <div class="lk">{lockup(c, 64, "dark")}</div></div>''' for i, c in enumerate(CONCEPTS))
    return f'''<!doctype html><html><head><style>{CSS}
    .b{{width:1600px;height:960px;box-sizing:border-box;padding:52px 60px;background:#0a0b0f}}
    h1{{font:600 30px sans-serif;margin:0 0 30px}} h1 span{{color:#5c6372;font-weight:400}}
    .grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}}
    .cell{{background:#111318;border:1px solid #1d2028;border-radius:24px;padding:28px;display:flex;flex-direction:column;gap:26px;height:388px;box-sizing:border-box;justify-content:space-between}}
    .top{{display:flex;gap:22px;align-items:center}} .n{{color:#5c6372;font:500 14px sans-serif;letter-spacing:.2em}} .t{{font:600 22px sans-serif;margin-top:4px}}
    .lk{{display:flex;align-items:center;min-height:80px}}
    </style></head><body><div class="b"><h1>Holdfast <span>· six logo directions</span></h1><div class="grid">{cells}</div></div></body></html>'''

for i, c in enumerate(CONCEPTS):
    open(f"board-{i + 1}-{c['key']}.html", "w").write(board(i, c))
open("overview.html", "w").write(overview())
print("ok")
