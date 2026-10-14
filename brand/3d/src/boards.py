import base64, glob
FD = "/tmp/claude-0/-home-user-holdfast/da1b599f-10d5-56da-8a34-5669c3fd33a8/scratchpad/fonts"
img = lambda f: "data:image/png;base64," + base64.b64encode(open(f"out/{f}", "rb").read()).decode()
def font(name, w):
    f = glob.glob(f"{FD}/fontsource-{name}-*/package/files/{name}-latin-{w}-normal.woff")[0]
    return f"data:font/woff;base64,{base64.b64encode(open(f, 'rb').read()).decode()}"
FONTS = f"""@font-face{{font-family:Unb;src:url({font('unbounded', 600)})}}@font-face{{font-family:UnbM;src:url({font('unbounded', 400)})}}
@font-face{{font-family:Cin;src:url({font('cinzel', 600)})}}@font-face{{font-family:Sora;src:url({font('sora', 600)})}}@font-face{{font-family:SoraL;src:url({font('sora', 300)})}}"""

V = [
    dict(key="gold-emerald", name="Gold & Emerald", hero="coin-gold-emerald.png", token="token-gold-emerald.png",
         wm="font-family:Unb;letter-spacing:.06em;color:#f1efe7", wml="font-family:Unb;letter-spacing:.06em;color:#0b0c10",
         glow="rgba(16,185,122,.22)", note="Gold coin, emerald moat. The app's own emerald, made precious."),
    dict(key="obsidian-gold", name="Obsidian & Gold", hero="coin-obsidian-gold.png", token="token-obsidian-gold.png",
         wm="font-family:Cin;letter-spacing:.24em;background:linear-gradient(180deg,#fbe7b0,#c99a3e);-webkit-background-clip:text;color:transparent",
         wml="font-family:Cin;letter-spacing:.24em;color:#1a1408", glow="rgba(233,191,98,.16)", note="Black coin, gold castle and moat. The private-bank version."),
    dict(key="emerald-gold", name="Emerald & Gold", hero="coin-emerald-gold.png", token="token-emerald-gold.png",
         wm="font-family:Sora;letter-spacing:.26em;color:#f1efe7", wml="font-family:Sora;letter-spacing:.26em;color:#0b0c10",
         glow="rgba(16,185,122,.24)", note="An emerald coin set in a gold moat, like a jewel."),
]
CSS = "body{margin:0;background:#08090c;color:#f1efe7;font-family:SoraL,sans-serif}" + FONTS

def board(i, v):
    return f'''<!doctype html><html><head><style>{CSS}
.b{{width:1600px;height:1000px;box-sizing:border-box;padding:54px 62px;display:flex;flex-direction:column;gap:28px;background:radial-gradient(900px 600px at 22% 55%,{v["glow"]},transparent 70%),#08090c}}
.h{{display:flex;justify-content:space-between;align-items:flex-end}} .h .n{{font:400 14px SoraL;letter-spacing:.3em;color:#6d7484}} .h h1{{font:600 34px Sora;margin:6px 0 0}}
.h p{{font:300 18px SoraL;color:#9aa1b0;margin:0;max-width:600px;text-align:right}}
.g{{display:flex;gap:26px;flex:1}} .hero{{width:560px;display:flex;align-items:center;justify-content:center}}
.c{{flex:1;display:flex;flex-direction:column;gap:22px}} .card{{flex:1;border-radius:24px;display:flex;align-items:center;justify-content:center;gap:28px}}
.d{{background:rgba(20,22,28,.85);border:1px solid #1e2129}} .l{{background:#f4f2ec}} .row{{display:flex;gap:22px;flex:1}}
.wm{{font-size:76px;line-height:1}} .tile{{width:150px;height:150px;border-radius:34px;background:radial-gradient(circle at 50% 40%,#1b2a24,#06080a 75%);display:flex;align-items:center;justify-content:center;box-shadow:inset 0 0 0 1px rgba(255,255,255,.07)}}
</style></head><body><div class="b">
<div class="h"><div><div class="n">MOAT · DIRECTION {i + 1:02d}</div><h1>{v["name"]}</h1></div><p>{v["note"]}</p></div>
<div class="g"><div class="hero"><img src="{img(v["hero"])}" width="560"></div>
<div class="c"><div class="card d"><img src="{img(v["token"])}" width="132"><span class="wm" style="{v["wm"]}">MOAT</span></div>
<div class="card l"><img src="{img(v["token"])}" width="132"><span class="wm" style="{v["wml"]}">MOAT</span></div>
<div class="row"><div class="card d"><div class="tile"><img src="{img(v["token"])}" width="132"></div>
<div style="width:150px;height:150px;border-radius:50%;background:radial-gradient(circle at 50% 40%,#1b2a24,#06080a 75%);display:flex;align-items:center;justify-content:center"><img src="{img(v["token"])}" width="128"></div></div>
<div class="card d" style="gap:22px"><img src="{img(v["token"])}" width="72"><img src="{img(v["token"])}" width="48"><img src="{img(v["token"])}" width="32"><img src="{img(v["token"])}" width="20"></div></div></div></div>
</div></body></html>'''

def banner(v):
    return f'''<!doctype html><html><head><style>{CSS}
.b{{width:1500px;height:500px;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;gap:56px;
background:radial-gradient(700px 400px at 34% 50%,{v["glow"]},transparent 70%),linear-gradient(180deg,#0b0d10,#060709)}}
.t .wm{{font-size:96px;line-height:1}} .t h2{{font:300 34px SoraL;margin:22px 0 14px;color:#e8e6df}} .t p{{font:300 20px SoraL;color:#8d94a3;margin:0}} .t b{{color:#e9bf62;font-weight:300}}
</style></head><body><div class="b"><img src="{img(v["hero"])}" width="380">
<div class="t"><div class="wm" style="{v["wm"]}">MOAT</div><h2>Every coin gets a moat.</h2>
<p><b>60%</b> floor vault &nbsp;·&nbsp; <b>30%</b> to holders every 2 min &nbsp;·&nbsp; <b>10%</b> buyback &amp; burn &nbsp;·&nbsp; <b>0%</b> dev</p></div></div></body></html>'''

def overview():
    cells = "".join(f'''<div class="cell"><img src="{img(v["hero"])}" width="380"><div class="lk"><img src="{img(v["token"])}" width="70"><span style="{v["wm"]};font-size:46px">MOAT</span></div><div class="nm">{i + 1:02d} · {v["name"]}</div></div>''' for i, v in enumerate(V))
    return f'''<!doctype html><html><head><style>{CSS}
.b{{width:1600px;height:740px;box-sizing:border-box;padding:50px 60px;background:radial-gradient(1000px 500px at 50% 45%,rgba(16,185,122,.12),transparent 70%),#08090c}}
h1{{font:600 30px Sora;margin:0}} h1 span{{font:300 30px SoraL;color:#6d7484}} .grid{{display:flex;gap:24px;margin-top:34px}}
.cell{{flex:1;background:rgba(20,22,28,.7);border:1px solid #1e2129;border-radius:26px;padding:26px;display:flex;flex-direction:column;align-items:center;gap:22px}}
.lk{{display:flex;align-items:center;gap:16px}} .nm{{font:400 15px SoraL;letter-spacing:.2em;color:#8d94a3;text-transform:uppercase}}
</style></head><body><div class="b"><h1>MOAT <span>· every coin gets a moat — three finishes</span></h1><div class="grid">{cells}</div></div></body></html>'''

for i, v in enumerate(V):
    open(f"board-{i + 1}-{v['key']}.html", "w").write(board(i, v))
    open(f"banner-{v['key']}.html", "w").write(banner(v))
open("overview.html", "w").write(overview())
