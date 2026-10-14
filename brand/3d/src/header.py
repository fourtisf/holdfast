"""Composes the premium X header (brand/png/moatpad-x-header-*.png) from the hero coin render.

    python3 brand/3d/src/header.py            # writes header-full.html / header-minimal.html next to this file
    # then screenshot them at 1500×500 with deviceScaleFactor 1 and 2 (see brand/README.md)

The coin is brand/3d/renders/hero-coin.png (hero.html, trimmed to its edges). The reflection is the same image
flipped under a glossy floor line; the gold dust is seeded, so the layout is reproducible.
"""
import base64
import os
import random

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "../../.."))
b64 = lambda f: base64.b64encode(open(f, "rb").read()).decode()
COIN_FILE = os.path.join(ROOT, "brand/3d/renders/hero-coin.png")
COIN = "data:image/png;base64," + b64(COIN_FILE)
GEIST = os.path.join(ROOT, "apps/web/node_modules/geist/dist/fonts/geist-sans")
CIN = "data:font/woff;base64," + b64(os.path.join(ROOT, "brand/fonts/Cinzel-SemiBold.woff"))
GL = "data:font/ttf;base64," + b64(f"{GEIST}/Geist-Light.ttf")
GR = "data:font/ttf;base64," + b64(f"{GEIST}/Geist-Regular.ttf")

w, h = Image.open(COIN_FILE).size
CH = 300
CW = CH * w / h
CX, CY = 1168, 205
REFL = 0.62

random.seed(11)
dots = []
for _ in range(95):
    near = random.random() < 0.7
    x = random.gauss(CX, 190) if near else random.uniform(420, 1500)
    y = random.gauss(CY, 120) if near else random.uniform(20, 470)
    if not (0 < x < 1500 and 0 < y < 500):
        continue
    big = random.random() < 0.18
    s = random.uniform(8, 18) if big else random.uniform(1.4, 4.2)
    op = random.uniform(0.08, 0.22) if big else random.uniform(0.35, 0.95)
    blur = s * 0.35 if big else 0.3
    dots.append(f'<i style="left:{x:.0f}px;top:{y:.0f}px;width:{s:.1f}px;height:{s:.1f}px;opacity:{op:.2f};filter:blur({blur:.1f}px)"></i>')


def page(variant):
    stats = ('<div class="stats"><span><b>60%</b> floor vault</span><i></i><span><b>30%</b> to holders every 2 min</span><i></i>'
             '<span><b>10%</b> buyback &amp; burn</span><i></i><span><b>0%</b> dev</span></div>') if variant == "full" else ""
    top = 118 if variant == "full" else 142
    floor_y = CY + CH / 2 + 22
    return f'''<!doctype html><html><head><style>
@font-face{{font-family:Cin;src:url({CIN})}} @font-face{{font-family:GL;src:url({GL})}} @font-face{{font-family:GR;src:url({GR})}}
body{{margin:0}} .b{{position:relative;width:1500px;height:500px;overflow:hidden;
 background:radial-gradient(460px 300px at {CX}px {CY}px,rgba(233,186,92,.22),transparent 70%),radial-gradient(700px 260px at {CX}px 520px,rgba(233,186,92,.07),transparent 70%),linear-gradient(180deg,#0e0f12 0%,#08090b 60%,#050506 100%)}}
.grain{{position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.03) 1px,transparent 1px);background-size:3px 3px}}
.floor{{position:absolute;left:560px;right:0;top:{floor_y - 4:.0f}px;height:1px;background:linear-gradient(90deg,transparent,rgba(233,191,98,.28) 55%,rgba(233,191,98,.08) 85%,transparent)}}
.pool{{position:absolute;left:{CX - 230}px;top:{CY + CH / 2 + 2:.0f}px;width:460px;height:60px;border-radius:50%;background:radial-gradient(closest-side,rgba(233,186,92,.20),transparent)}}
.coin{{position:absolute;left:{CX - CW / 2:.1f}px;top:{CY - CH / 2:.1f}px;width:{CW:.1f}px;height:{CH}px;filter:drop-shadow(0 18px 40px rgba(0,0,0,.6))}}
.refl{{position:absolute;left:{CX - CW / 2:.1f}px;top:{floor_y:.1f}px;width:{CW:.1f}px;height:{CH}px;transform:translateY({REFL * CH:.0f}px) scaleY(-{REFL});transform-origin:top;opacity:.42;
 -webkit-mask-image:linear-gradient(0deg,rgba(0,0,0,.9),transparent 55%);mask-image:linear-gradient(0deg,rgba(0,0,0,.9),transparent 55%);filter:blur(1.2px)}}
.dust i{{position:absolute;border-radius:50%;background:radial-gradient(circle,#fff3cf,#f0c46a 45%,rgba(240,196,106,0) 72%)}}
.vig{{position:absolute;inset:0;background:radial-gradient(1200px 560px at 58% 42%,transparent 55%,rgba(0,0,0,.6))}}
.t{{position:absolute;left:440px;top:{top}px}}
.wm{{font-family:Cin;font-size:86px;line-height:1;letter-spacing:.17em;background:linear-gradient(180deg,#fff3cc 0%,#efc76c 50%,#b4842e 100%);-webkit-background-clip:text;color:transparent;filter:drop-shadow(0 2px 16px rgba(233,186,92,.16))}}
.rule{{width:78px;height:1px;margin:24px 0 20px;background:linear-gradient(90deg,#e9bf62,rgba(233,191,98,0))}}
.tag{{font:300 30px GL;color:#efebe1;letter-spacing:.005em}}
.stats{{display:flex;align-items:center;gap:13px;margin-top:20px;font:300 16px GL;color:#8e939f;letter-spacing:.02em}}
.stats b{{font-weight:300;color:#ecc56b}} .stats i{{width:3px;height:3px;border-radius:50%;background:#4a4e57}}
.url{{position:absolute;right:44px;top:32px;font:400 12.5px GR;letter-spacing:.34em;color:#a8916a}}
</style></head><body><div class="b"><div class="grain"></div><div class="pool"></div><div class="floor"></div>
<img class="refl" src="{COIN}"><div class="dust">{"".join(dots)}</div><img class="coin" src="{COIN}"><div class="vig"></div>
<div class="url">MOATPAD.FUN</div>
<div class="t"><div class="wm">MOATPAD</div><div class="rule"></div><div class="tag">Every coin gets a moat.</div>{stats}</div></div></body></html>'''


for v in ("full", "minimal"):
    with open(os.path.join(HERE, f"header-{v}.html"), "w") as f:
        f.write(page(v))
