"""Six premium logo directions for Holdfast, each on a 100×100 grid."""
from math import sqrt

def poly(pts, fill, extra=""):
    return f'<polygon points="{" ".join(f"{x:g},{y:g}" for x, y in pts)}" fill="{fill}"{extra}/>'

# 1 · RISING COIN — a coin split at its floor; the top half lifts off. Flat.
def coin(c):
    # the floor is a thin slab; the coin above it has lifted clear
    r, cy, chord, lift = 34, 50, 70, 9
    h = sqrt(r * r - (chord - cy) ** 2)
    return (f'<path d="M{50 - h:.3f} {chord} A{r} {r} 0 0 0 {50 + h:.3f} {chord} Z" fill="{c}"/>'
            f'<path d="M{50 - h:.3f} {chord - lift} A{r} {r} 0 1 1 {50 + h:.3f} {chord - lift} Z" fill="{c}"/>')

# 2 · VAULT SEAL — vault-door ring with eight bolts, a chevron rising over the floor bar. Gold.
def vault(c, ring=None):
    ring = ring or c
    bolts = "".join(f'<circle cx="50" cy="12" r="2.1" fill="#0b0a07" transform="rotate({a} 50 50)"/>' for a in range(0, 360, 45))
    return (f'<circle cx="50" cy="50" r="45.5" fill="none" stroke="{ring}" stroke-width="1.4"/>'
            f'<circle cx="50" cy="50" r="38" fill="none" stroke="{ring}" stroke-width="7"/>{bolts}'
            + poly([(32, 57), (50, 39), (68, 57), (68, 66), (50, 48), (32, 66)], c)
            + f'<rect x="32" y="71" width="36" height="5" fill="{c}"/>')

# 3 · ANCHOR ARROW — an anchor whose ring is an arrow pointing up. Hold fast, rise.
def anchor(c):
    s = f'fill="none" stroke="{c}" stroke-width="6.5"'
    return (f'<path d="M50 85 V22" {s}/>'
            f'<path d="M37 34 L50 20 L63 34" {s} stroke-linejoin="miter" stroke-miterlimit="10"/>'
            f'<path d="M39 46 H61" {s}/>'
            f'<path d="M23 59 A27 27 0 0 0 77 59" {s}/>'
            + poly([(16.5, 63), (23, 51), (29.5, 63)], c) + poly([(70.5, 63), (77, 51), (83.5, 63)], c))

# 4 · HF MONOGRAM — H and F share a stem; tops cut on one rising angle.
def hf(c):
    w, k = 12, 0.55  # stem width, slope of every cut
    def stem(x, top):
        return [(x, top + w * k), (x + w, top), (x + w, 86), (x, 86)]
    return (poly(stem(18, 22), c) + poly(stem(46, 14), c)
            + poly([(30, 50), (46, 50), (46, 60), (30, 60)], c)
            + poly([(58, 14), (84, 14), (84 - 10 * k * 0, 24), (58, 24)], c)
            + poly([(58, 44), (78, 44), (78, 54), (58, 54)], c))

# 5 · KELP — a frond rising from a holdfast gripping a stone. Organic, heritage.
def kelp(c, accent=None):
    a = accent or c
    stem = f'<path d="M50 84 C49 70 54 60 51 48 C48 36 53 26 52 14" fill="none" stroke="{c}" stroke-width="3.6" stroke-linecap="round"/>'
    leaves = (f'<path d="M50.5 62 C42 60 30 54 22 42 C34 44 45 50 50.5 62 Z" fill="{c}"/>'
              f'<path d="M51.5 46 C60 43 70 36 78 24 C66 27 56 34 51.5 46 Z" fill="{c}"/>'
              f'<path d="M51 30 C45 27 38 21 34 12 C42 14 48 20 51 30 Z" fill="{c}"/>')
    roots = f'<path d="M50 84 C44 84 39 87 36 92 M50 84 C56 84 61 87 64 92 M50 84 V92" fill="none" stroke="{a}" stroke-width="3" stroke-linecap="round"/>'
    stone = f'<ellipse cx="50" cy="91" rx="11" ry="4.2" fill="{a}"/>'
    return stem + leaves + roots + stone

# 6 · FORTRESS — battlements whose centre merlon is an arrow: the wall holds, the price rises.
def fortress(c):
    return (poly([(14, 70), (86, 70), (86, 86), (14, 86)], c)
            + poly([(14, 50), (29, 50), (29, 70), (14, 70)], c) + poly([(71, 50), (86, 50), (86, 70), (71, 70)], c)
            + poly([(44, 70), (44, 42), (34, 42), (50, 18), (66, 42), (56, 42), (56, 70)], c))

# 7 · DIAMOND — a brilliant-cut gem: diamond hands, the people Holdfast pays. Faceted, jewel-toned.
def diamond(c, tones=None):
    t = tones or ["#f2fffa", "#b9f7dc", "#6fe3ae", "#3cc489", "#1f9c69", "#0d6e48"]
    if tones is False:
        t = [c] * 6
    g = 'stroke="{bg}" stroke-width="1.6" stroke-linejoin="round"'
    T, G, B = 24, 40, 86          # table, girdle, culet heights
    pts = dict(tl=(34, T), tr=(66, T), gl=(14, G), gr=(86, G), c1=(28, G), c2=(50, G), c3=(72, G), cu=(50, B))
    P = lambda *k: [pts[x] for x in k]
    faces = [
        (P("tl", "tr", "c2"), t[0]), (P("tl", "c2", "c1"), t[1]), (P("tr", "c3", "c2"), t[2]),
        (P("tl", "c1", "gl"), t[2]), (P("tr", "gr", "c3"), t[3]),
        (P("gl", "c1", "cu"), t[3]), (P("c1", "c2", "cu"), t[2]), (P("c2", "c3", "cu"), t[4]), (P("c3", "gr", "cu"), t[5]),
    ]
    return "".join(poly(p, f, " " + g) for p, f in faces)

# 8 · LIGHTHOUSE — stands on the rock through every storm and lights the way. Maritime, steady.
def lighthouse(c, beam=None):
    b = beam or c
    return (poly([(30, 12), (43, 27), (43, 31), (8, 26)], b, ' fill-opacity="0.45"')
            + poly([(70, 12), (57, 27), (57, 31), (92, 26)], b, ' fill-opacity="0.45"')
            + poly([(41, 21), (50, 12), (59, 21)], c)
            + f'<rect x="43" y="23" width="14" height="10" fill="{c}"/>'
            + f'<rect x="37" y="35" width="26" height="3.6" fill="{c}"/>'
            + poly([(41, 40.5), (59, 40.5), (60.2, 52), (39.8, 52)], c)
            + poly([(39.4, 56), (60.6, 56), (61.8, 68), (38.2, 68)], c)
            + poly([(37.8, 72), (62.2, 72), (63.4, 84), (36.6, 84)], c)
            + f'<rect x="24" y="86" width="52" height="4.5" rx="2.25" fill="{c}"/>')

GOLD = "url(#gold)"
CONCEPTS = [
    dict(key="coin", name="Rising Coin", fn=coin, dark="#5fe8a8", light="#0a6b45", tile="#07080c",
         font="unbounded", weight=600, text="holdfast", track=-0.02,
         idea="A coin split at its floor: the bottom holds, the top lifts off. Flat, minimal, one colour."),
    dict(key="vault", name="Vault Seal", fn=vault, dark=GOLD, light="#7a5a1e", tile="#0b0a07",
         font="cinzel", weight=600, text="HOLDFAST", track=0.2,
         idea="A vault door with eight bolts; inside, a chevron rises over the floor. Gold on black, private-bank luxury."),
    dict(key="anchor", name="Anchor Arrow", fn=anchor, dark="#f3f5f2", light="#073d29", tile="url(#bank)",
         font="sora", weight=600, text="Holdfast", track=-0.01,
         idea="An anchor whose ring is an arrow pointing up. Holding fast and rising, in one symbol."),
    dict(key="kelp", name="Kelp", fn=kelp, dark="#efe6cf", light="#123a2a", tile="#0d2219",
         font="cormorant-garamond", weight=600, text="Holdfast", track=0.02,
         idea="A kelp frond rising from the holdfast that grips its stone: the name, drawn. Heritage, calm, organic."),
    dict(key="diamond", name="Diamond Hands", fn=diamond, dark="#07080c", light="#07080c", tile="#07080c", light_tones=False,
         font="syne", weight=700, text="HOLDFAST", track=0.06,
         idea="A brilliant-cut diamond: the diamond hands Holdfast pays every two minutes. Faceted and jewel-toned."),
    dict(key="lighthouse", name="Lighthouse", fn=lighthouse, dark="#e9f6f0", light="#0b2a3a", tile="url(#sea)",
         font="sora", weight=300, text="HOLDFAST", track=0.32,
         idea="A lighthouse on its rock: it holds through every storm and shows the way in. Maritime, calm, trusted."),
]

DEFS = """<defs>
<linearGradient id="gold" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#fbebbd"/><stop offset="0.5" stop-color="#d9ad55"/><stop offset="1" stop-color="#8f6722"/></linearGradient>
<linearGradient id="emerald" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#c9fde3"/><stop offset="0.5" stop-color="#4fe0a0"/><stop offset="1" stop-color="#0b8a57"/></linearGradient>
<linearGradient id="sea" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#123b52"/><stop offset="1" stop-color="#06131c"/></linearGradient>
<linearGradient id="bank" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f5a3e"/><stop offset="1" stop-color="#042318"/></linearGradient>
</defs>"""
