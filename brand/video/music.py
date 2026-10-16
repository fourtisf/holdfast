"""Original soundtracks for the promo videos, synthesized from scratch (no samples, no third-party music).

    python3 brand/video/music.py            # writes brand/video/music-tour.wav (60 s) and music-live.wav (24 s)
    python3 brand/video/music.py burn       # only music-burn.wav (32 s), for burn.html
    python3 brand/video/music.py bot        # only music-bot.wav (50 s), for bot.html (needs sfx-bot.json from render.mjs)

Cinematic electronic in A minor: warm detuned pads, a sub bass ducked by the kick, plucked arpeggios through a
dotted-eighth delay, hats and claps, risers and impacts on the cuts. Every section boundary lands on a scene change
of tour.html / live.html. Loudness is normalized afterwards with ffmpeg (loudnorm) when the audio is muxed.
"""
import os
import wave

import numpy as np

SR = 44_100
HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(7)


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def tt(dur):
    return np.arange(int(dur * SR)) / SR


def place(buf, sample, start, gain=1.0, pan=0.0):
    """Adds a mono (n,) or stereo (n, 2) sample at `start` seconds, equal-power panned."""
    i = int(round(start * SR))
    if i >= len(buf) or i + len(sample) <= 0:
        return
    s = sample[max(0, -i):] * gain
    i = max(0, i)
    j = min(len(buf), i + len(s))
    s = s[: j - i]
    if s.ndim == 1:
        a = (pan + 1) * np.pi / 4
        buf[i:j, 0] += s * np.cos(a) * 1.414
        buf[i:j, 1] += s * np.sin(a) * 1.414
    else:
        buf[i:j] += s


def fft_filter(x, lo=None, hi=None, soft=0.25):
    """Band-limits a short mono signal with smooth (log-gaussian) edges, in the frequency domain."""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR) + 1e-9
    g = np.ones_like(f)
    if lo:
        g *= 1 / (1 + (lo / f) ** (1 / soft))
    if hi:
        g *= 1 / (1 + (f / hi) ** (1 / soft))
    return np.fft.irfft(X * g, len(x))


# ---- instruments --------------------------------------------------------------------------------------------
def kick(dur=0.5):
    t = tt(dur)
    phase = 2 * np.pi * (44 * t + 90 * 0.045 * (1 - np.exp(-t / 0.045)))
    body = np.sin(phase) * np.exp(-t / 0.30)
    click = fft_filter(rng.standard_normal(len(t)), lo=1500, hi=6000) * np.exp(-t / 0.004) * 0.35
    return np.tanh((body + click) * 1.4) * 0.9


def clap(dur=0.45):
    t = tt(dur)
    noise = fft_filter(rng.standard_normal(len(t)), lo=900, hi=5000)
    env = np.zeros_like(t)
    for d in (0.0, 0.011, 0.022):
        env += np.where(t >= d, np.exp(-(t - d) / 0.008), 0)
    env += np.where(t >= 0.03, np.exp(-(t - 0.03) / 0.14), 0) * 0.6
    return noise / np.max(np.abs(noise)) * env * 0.5


def hat(dur=0.09, open_=False):
    t = tt(dur if not open_ else 0.3)
    noise = fft_filter(rng.standard_normal(len(t)), lo=7000)
    return noise / np.max(np.abs(noise)) * np.exp(-t / (0.025 if not open_ else 0.11)) * 0.35


def pluck(freq, dur=0.5):
    t = tt(dur)
    s = np.zeros_like(t)
    for h, a in ((1, 1.0), (2, 0.45), (3, 0.22), (4, 0.12), (5, 0.06)):
        s += a * np.sin(2 * np.pi * freq * h * t) * np.exp(-t / (0.22 / h ** 0.6))
    return s * (1 - np.exp(-t / 0.002)) * 0.35


def pad_note(freq, dur, attack=0.7, release=1.2, bright=1.0):
    """Stereo detuned supersaw-ish pad, harmonics rolled off (a static lowpass)."""
    t = tt(dur + release)
    out = np.zeros((len(t), 2))
    for ch, detunes in ((0, (-0.0016, 0.0, 0.0011)), (1, (-0.0010, 0.0, 0.0017))):
        for dt in detunes:
            ph = rng.uniform(0, 2 * np.pi)
            for h in range(1, 7):
                out[:, ch] += np.sin(2 * np.pi * freq * (1 + dt) * h * t + ph * h) / h ** (1.6 - 0.3 * bright)
    env = np.minimum(1, t / attack) * np.where(t > dur, np.exp(-(t - dur) / (release / 3)), 1)
    return out * env[:, None] * 0.05


def bass_note(freq, dur):
    t = tt(dur)
    s = np.sin(2 * np.pi * freq * t) + 0.35 * np.sin(2 * np.pi * 2 * freq * t) + 0.12 * np.sin(2 * np.pi * 3 * freq * t)
    env = np.minimum(1, t / 0.006) * (0.65 + 0.35 * np.exp(-t / 0.08)) * np.minimum(1, (dur - t) / 0.02).clip(0, 1)
    return np.tanh(s * env * 1.6) * 0.42


def riser(dur):
    t = tt(dur)
    noise = rng.standard_normal(len(t))
    # sweep the band upwards in slices
    out = np.zeros_like(t)
    n = 24
    for k in range(n):
        a, b = int(k * len(t) / n), int((k + 1) * len(t) / n)
        lo = 300 * (24 ** (k / n))
        seg = fft_filter(noise[a:b], lo=lo, hi=lo * 4)
        out[a:b] = seg / (np.max(np.abs(seg)) + 1e-9)
    tone = np.sin(2 * np.pi * np.cumsum(220 * 2 ** (2 * t / dur)) / SR) * 0.15
    return (out * 0.25 + tone) * (t / dur) ** 2.2


def impact(dur=2.5):
    t = tt(dur)
    boom = np.sin(2 * np.pi * (38 * t + 60 * 0.08 * (1 - np.exp(-t / 0.08)))) * np.exp(-t / 0.9)
    air = fft_filter(rng.standard_normal(len(t)), lo=200, hi=9000) * np.exp(-t / 0.35) * 0.18
    return np.tanh((boom + air) * 1.3) * 0.8


def reverb(x, seconds=2.4, wet=0.3):
    """Convolution with a decorrelated, exponentially decaying noise tail (stereo)."""
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = np.zeros((len(x) + n, 2))
    for ch in range(2):
        ir = rng.standard_normal(n) * np.exp(-t / (seconds / 6.9)) * (1 - np.exp(-t / 0.01))
        ir = fft_filter(ir, lo=180, hi=7000)
        ir /= np.sqrt(np.sum(ir ** 2))
        size = 1 << int(np.ceil(np.log2(len(x) + n)))
        out[:, ch] = np.fft.irfft(np.fft.rfft(x[:, ch], size) * np.fft.rfft(ir, size), size)[: len(x) + n]
    return out[: len(x)] * wet


def delay(x, d, fb=0.35, mix=0.35, taps=5):
    out = np.zeros_like(x)
    k = int(d * SR)
    for i in range(1, taps + 1):
        g = mix * fb ** (i - 1)
        ch = i % 2  # ping-pong
        out[k * i:, ch] += x[: len(x) - k * i, 0 if ch else 1] * g if k * i < len(x) else 0
    return out


def duck_curve(n, hits, depth=0.55, release=0.16):
    env = np.ones(n)
    t = np.arange(n) / SR
    for h in hits:
        i = int(h * SR)
        seg = t[i:] - h
        env[i:] = np.minimum(env[i:], 1 - depth * np.exp(-seg / release))
    return env


def master(mix, path):
    mix = mix - mix.mean(axis=0)
    mix = np.tanh(mix * 1.15) / np.tanh(1.15)
    mix *= 0.89 / np.max(np.abs(mix))
    pcm = (mix * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    print(f"wrote {path} ({len(mix) / SR:.1f} s)")


# ---- arrangement helpers -------------------------------------------------------------------------------------
# A minor: Am - F - C - G (one chord per bar)
CHORDS = [(57, 60, 64), (53, 57, 60), (48, 52, 55), (55, 59, 62)]
ROOTS = [33, 29, 36, 31]  # A1 F1 C2 G1


def song(total, bpm, bars, start=0.0, sections=None):
    """`sections`: list of (first_bar, last_bar, set of parts) on a bar grid starting at `start` seconds."""
    beat = 60 / bpm
    bar = beat * 4
    n = int(total * SR)
    drums = np.zeros((n, 2))
    bass = np.zeros((n, 2))
    pads = np.zeros((n, 2))
    arps = np.zeros((n, 2))
    fx = np.zeros((n, 2))
    kicks = []
    K, C, H, HO = kick(), clap(), hat(), hat(open_=True)
    for b in range(bars):
        t0 = start + b * bar
        if t0 >= total:
            break
        parts = set()
        for lo, hi, p in sections:
            if lo <= b <= hi:
                parts |= p
        chord = CHORDS[b % 4]
        root = ROOTS[b % 4]
        if "pad" in parts or "padbright" in parts:
            for m in chord + (chord[0] + 12,):
                place(pads, pad_note(hz(m), bar, bright=1.0 if "padbright" in parts else 0.6), t0)
        if "kick" in parts:
            for q in range(4):
                place(drums, K, t0 + q * beat, 0.95)
                kicks.append(t0 + q * beat)
        if "clap" in parts:
            for q in (1, 3):
                place(drums, C, t0 + q * beat, 0.6, pan=0.05)
        if "hat" in parts:
            for e in range(8):
                if e % 2 == 1:
                    place(drums, HO if e == 7 and b % 2 else H, t0 + e * beat / 2, 0.5 + 0.15 * (e % 4 == 3), pan=0.25)
            if "hat16" in parts:
                for s in range(16):
                    if s % 2 == 0:
                        place(drums, H, t0 + s * beat / 4, 0.18, pan=-0.3)
        if "bass" in parts:
            for e in range(8):
                f = hz(root + (12 if ("bassoct" in parts and e % 2) else 0))
                place(bass, bass_note(f, beat / 2 * 0.9), t0 + e * beat / 2, 1.0)
        if "sub" in parts:
            place(bass, bass_note(hz(root), bar * 0.95), t0, 0.8)
        if "arp" in parts or "arpup" in parts:
            pattern = [0, 2, 1, 3, 2, 1, 3, 2]  # chord tones, 3 = octave
            notes = list(chord) + [chord[0] + 12]
            for s in range(16):
                m = notes[pattern[s % 8]] + (12 if "arpup" in parts else 0)
                place(arps, pluck(hz(m)), t0 + s * beat / 4, 0.55 if s % 4 == 0 else 0.38, pan=-0.35 if s % 2 else 0.35)
        if "riser" in parts:
            place(fx, riser(bar), t0, 0.7)
    duck = duck_curve(n, kicks)
    bass *= duck[:, None]
    pads *= (0.6 + 0.4 * duck)[:, None]
    arps_wet = arps + delay(arps, beat * 0.75)
    send = pads * 0.8 + arps_wet * 0.7 + drums * 0.12 + fx * 0.6
    mix = drums * 0.95 + bass * 0.9 + pads * 0.75 + arps_wet * 0.55 + fx * 0.7 + reverb(send, 2.6, 0.32)
    return mix, fx


def fade(mix, start, end):
    n = len(mix)
    t = np.arange(n) / SR
    g = np.clip((end - t) / (end - start), 0, 1) ** 1.5
    g[t < start] = 1
    return mix * g[:, None]


# ---- tour: 100 BPM, 24 bars of 2.4 s, scene cuts on bar lines (tour.html) -----------------------------------
def tour():
    total = 60.0
    S = [
        (0, 1, {"pad", "sub"}),
        (1, 1, {"riser"}),
        (2, 8, {"pad", "kick", "hat", "bass", "arp"}),
        (9, 14, {"padbright", "kick", "hat", "hat16", "clap", "bass", "arp"}),
        (15, 15, {"pad", "arp", "sub"}),
        (16, 17, {"pad", "kick", "hat", "bass", "arp", "riser"}),
        (18, 21, {"padbright", "kick", "hat", "hat16", "clap", "bass", "bassoct", "arpup"}),
        (22, 24, {"pad", "sub"}),
    ]
    mix, _ = song(total, 100, 25, 0.0, S)
    for at, g in ((4.8, 0.9), (43.2, 1.0), (52.8, 0.9)):
        place(mix, np.stack([impact()] * 2, axis=1), at, g)
    mix = fade(mix, 55.5, 60.0)
    master(mix, os.path.join(HERE, "music-tour.wav"))


# ---- live: 120 BPM, 24 s (live.html) --------------------------------------------------------------------------
def saw_stack(midis, dur, attack=0.25, decay=2.0, detunes=(-0.004, 0.0, 0.003), cutoff=2400):
    """Low brass-like "braam": detuned saws whose harmonics open up over the attack."""
    t = tt(dur)
    out = np.zeros((len(t), 2))
    bright = np.minimum(1, t / max(attack, 1e-3))
    for m in midis:
        f0 = hz(m)
        for ch, dts in ((0, detunes), (1, tuple(-d for d in detunes))):
            for dt in dts:
                f = f0 * (1 + dt)
                for h in range(1, int(cutoff / f) + 1):
                    out[:, ch] += np.sin(2 * np.pi * f * h * t + h * 0.7) / h ** (2.0 - 0.8 * bright)
    env = np.minimum(1, t / attack) * np.exp(-np.maximum(0, t - attack) / decay)
    return np.tanh(out * env[:, None] * 0.12) * 0.9


def tom(freq=70, dur=0.9):
    t = tt(dur)
    body = np.sin(2 * np.pi * (freq * t + freq * 0.7 * 0.06 * (1 - np.exp(-t / 0.06)))) * np.exp(-t / 0.4)
    hit = fft_filter(rng.standard_normal(len(t)), lo=300, hi=3000) * np.exp(-t / 0.02) * 0.4
    return np.tanh((body + hit) * 1.5) * 0.8


def snare(dur=0.25):
    t = tt(dur)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.045) * 0.5
    noise = fft_filter(rng.standard_normal(len(t)), lo=1200, hi=9000)
    return (tone + noise / np.max(np.abs(noise)) * np.exp(-t / 0.08)) * 0.45


def tick(dur=0.05):
    t = tt(dur)
    noise = fft_filter(rng.standard_normal(len(t)), lo=3000, hi=11000)
    return (noise / np.max(np.abs(noise)) * np.exp(-t / 0.004) + np.sin(2 * np.pi * 2600 * t) * np.exp(-t / 0.006)) * 0.25


def reverse_cymbal(dur):
    t = tt(dur)
    noise = fft_filter(rng.standard_normal(len(t)), lo=3500)
    return noise / np.max(np.abs(noise)) * (t / dur) ** 3 * 0.5


def whoosh(dur=0.7):
    t = tt(dur)
    noise = rng.standard_normal(len(t))
    out = np.zeros_like(t)
    n = 16
    for k in range(n):
        a, b = int(k * len(t) / n), int((k + 1) * len(t) / n)
        c = 600 * 10 ** (np.sin(np.pi * (k + 0.5) / n) * 1.0)
        seg = fft_filter(noise[a:b], lo=c / 2, hi=c * 2)
        out[a:b] = seg / (np.max(np.abs(seg)) + 1e-9)
    return out * np.sin(np.pi * t / dur) ** 2 * 0.3


def subdrop(dur=1.6):
    t = tt(dur)
    f = 30 + 60 * np.exp(-t / 0.35)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.9) * 0.9


def live():
    total, beat, drop = 24.0, 0.5, 8.0
    n = int(total * SR)
    st = lambda x: np.stack([x, x], axis=1)
    fx = np.zeros((n, 2))

    # 0-4: cold open, a braam and a pad over a drone, a riser into the countdown
    place(fx, saw_stack((33, 40, 45), 4.2, attack=1.4, decay=2.5), 0.0, 0.9)
    for m in CHORDS[0] + (CHORDS[0][0] + 12,):
        place(fx, pad_note(hz(m), 3.6, attack=1.6, release=1.0, bright=0.4), 0.0, 1.0)
    place(fx, riser(2.2), 1.8, 0.7)
    # 4-7.75: the vault dial: a hit on every count, ticks on the 8ths, a snare roll and a reverse cymbal into the gap
    for k, at in enumerate((4.0, 5.0, 6.0)):
        place(fx, st(impact(1.4)) * (0.7 + 0.1 * k), at)
        place(fx, st(tom(hz(33 + 3 * k), 0.9)), at, 0.9)
        place(fx, saw_stack((33 + 3 * k, 40 + 3 * k), 0.9, attack=0.02, decay=0.35), at, 0.8)
    for i in range(int(3.75 / (beat / 2))):
        at = 4.0 + i * beat / 2
        place(fx, tick(), at, 0.5 + 0.25 * (i % 2 == 0), pan=0.3 if i % 2 else -0.3)
    roll = 6.0
    while roll < 7.7:
        gap = 0.125 if roll < 6.9 else 0.0625
        place(fx, snare(), roll, 0.25 + 0.55 * (roll - 6.0) / 1.7, pan=0.1)
        roll += gap
    place(fx, riser(1.75), 6.0, 0.9)
    place(fx, reverse_cymbal(1.6), 6.15, 0.9)
    fx[int(7.75 * SR): int(drop * SR)] *= np.linspace(1, 0, int(drop * SR) - int(7.75 * SR))[:, None] ** 3  # the breath before the drop

    # 8-20: the drop, then 20-24 the outro
    groove, _ = song(total, 120, 6, drop, [
        (0, 4, {"padbright", "kick", "hat", "hat16", "clap", "bass", "bassoct", "arpup"}),
        (5, 5, {"padbright", "kick", "hat", "hat16", "clap", "bass", "arpup", "riser"}),
    ])
    outro, _ = song(total, 120, 2, 20.0, [(0, 1, {"pad", "sub", "arp"})])
    hits = np.zeros((n, 2))
    place(hits, st(impact(3.0)), drop, 1.2)
    place(hits, st(subdrop()), drop, 1.0)
    place(hits, saw_stack((33, 45, 52), 2.5, attack=0.03, decay=1.2), drop, 0.7)
    for at in (11.75, 13.25, 14.75, 16.25):  # whooshes into each feature hit
        place(hits, st(whoosh(0.5)), at, 0.8, )
    for i in range(8):  # fill into the fee split
        place(hits, snare(), 17.0 + i * beat / 4 + 0.5, 0.5 + 0.06 * i)
    for i in range(5):  # one hit per segment of the fee split
        place(hits, st(tom(hz(45 + i * 2), 0.5)), 18.25 + i * 0.25, 0.6)
    place(hits, st(impact(3.5)), 20.0, 1.1)
    place(hits, saw_stack((33, 40, 45), 3.5, attack=0.03, decay=1.6), 20.0, 0.6)
    fx += reverb(fx, 2.2, 0.3)
    hits += reverb(hits, 2.6, 0.25)
    mix = fx + groove + outro * 0.9 + hits
    mix = fade(mix, 22.4, 24.0)
    master(mix, os.path.join(HERE, "music-live.wav"))


# ---- demo: the launch demo (build-demo.sh), synced to the capture's marks (demo-app.json) ------------------
def demo():
    import json
    marks = json.load(open(os.path.join(HERE, "demo-app.json")))
    intro = 4.0
    live, buyback, app_end = intro + marks["live"], intro + marks["buyback"], intro + marks["seconds"]
    total = app_end + 7.0
    n = int(total * SR)
    st = lambda x: np.stack([x, x], axis=1)
    beat, bar = 0.5, 2.0

    fx = np.zeros((n, 2))
    place(fx, st(impact(2.5)), 0.05, 1.0)
    place(fx, saw_stack((33, 40, 45), 3.8, attack=0.05, decay=1.6), 0.05, 0.6)
    for m in CHORDS[0] + (CHORDS[0][0] + 12,):
        place(fx, pad_note(hz(m), 3.4, attack=0.8, release=0.8, bright=0.5), 0.3, 1.0)
    place(fx, riser(1.6), intro - 1.6, 0.7)

    # the launch: a steady groove on the bar grid from the end of the intro
    launch_bars = int((live - intro) // bar)
    groove, _ = song(total, 120, launch_bars, intro, [
        (0, 1, {"pad", "kick", "hat", "sub"}),
        (2, launch_bars, {"pad", "kick", "hat", "bass", "arp"}),
    ])
    # live: the drop from the next bar line until the end of the capture
    drop_at = intro + bar * np.ceil((live - intro) / bar)
    drop_bars = int((app_end - drop_at) // bar) + 1
    full, _ = song(total, 120, drop_bars, drop_at, [(0, drop_bars, {"padbright", "kick", "hat", "hat16", "clap", "bass", "bassoct", "arpup"})])
    full = fade(full, app_end - 0.3, app_end + 0.4)
    outro, _ = song(total, 120, 4, app_end, [(0, 3, {"pad", "sub", "arp"})])

    hits = np.zeros((n, 2))
    place(hits, st(impact(3.0)), live, 1.1)
    place(hits, st(subdrop()), live, 0.9)
    place(hits, saw_stack((33, 45, 52), 2.2, attack=0.03, decay=1.1), live, 0.6)
    place(hits, st(whoosh(0.6)), live - 0.55, 0.8)
    place(hits, st(impact(1.8)), buyback, 0.75)
    place(hits, st(tom(hz(40), 0.8)), buyback, 0.7)
    place(hits, st(impact(3.0)), app_end, 1.0)
    fx += reverb(fx, 2.2, 0.3)
    hits += reverb(hits, 2.4, 0.25)
    mix = fx + groove * 0.9 + full + outro * 0.9 + hits
    mix = fade(mix, total - 1.6, total)
    master(mix, os.path.join(HERE, "music-demo.wav"))


# ---- burn: the buy & burn feature video (burn.html), 120 BPM, scenes on bar lines ---------------------------
def burn():
    total, beat, drop = 32.0, 0.5, 4.0
    n = int(total * SR)
    st = lambda x: np.stack([x, x], axis=1)

    # 0-4: the ignition: a low braam, a dark pad, the title hit at 1.3 s, a riser into the drop
    fx = np.zeros((n, 2))
    place(fx, saw_stack((33, 40, 45), 3.6, attack=0.9, decay=2.2), 0.0, 0.7)
    for m in CHORDS[0] + (CHORDS[0][0] + 12,):
        place(fx, pad_note(hz(m), 3.6, attack=1.2, release=0.9, bright=0.45), 0.0, 1.0)
    place(fx, riser(1.8), 2.2, 0.75)
    place(fx, reverse_cymbal(1.2), 2.8, 0.7)

    # 4-24: the groove (trades, the split, buy then burn), 24-28 the flywheel, 28-32 the outro
    groove, _ = song(total, 120, 12, drop, [
        (0, 2, {"pad", "kick", "hat", "bass", "arp"}),
        (3, 5, {"pad", "kick", "hat", "clap", "bass", "arp"}),
        (6, 9, {"padbright", "kick", "hat", "hat16", "clap", "bass", "bassoct", "arpup"}),
        (10, 10, {"padbright", "kick", "hat", "hat16", "clap", "bass", "arpup"}),
        (11, 11, {"padbright", "kick", "hat", "hat16", "clap", "bass", "arpup", "riser"}),
    ])
    groove = fade(groove, 27.85, 28.05)
    outro, _ = song(total, 120, 2, 28.0, [(0, 1, {"pad", "sub", "arp"})])

    hits = np.zeros((n, 2))
    place(hits, st(impact(2.6)), 1.3, 1.1)
    place(hits, st(subdrop()), 1.3, 0.9)
    place(hits, saw_stack((33, 45, 52), 2.4, attack=0.03, decay=1.2), 1.3, 0.55)
    place(hits, st(impact(2.2)), drop, 0.8)
    place(hits, st(whoosh(0.6)), 9.45, 0.7)
    for i in range(5):  # one hit per segment of the fee split
        place(hits, st(tom(hz(45 + i * 2), 0.5)), 10.5 + i * 0.5, 0.65)
    place(hits, st(whoosh(0.5)), 12.55, 0.8)
    place(hits, st(impact(2.4)), 13.0, 0.95)  # the 10% catches fire
    place(hits, saw_stack((40, 47, 52), 1.8, attack=0.03, decay=0.9), 13.0, 0.45)
    for at in (15.5, 17.8, 19.8):  # whooshes into each step card
        place(hits, st(whoosh(0.5)), at, 0.75)
    place(hits, st(impact(1.8)), 20.3, 0.7)  # the burn
    for i in range(8):  # fill into the flywheel
        place(hits, snare(), 23.0 + i * beat / 4 + 0.5, 0.45 + 0.06 * i)
    place(hits, st(impact(1.6)), 24.0, 0.6)
    place(hits, st(impact(3.4)), 28.0, 1.15)
    place(hits, st(subdrop()), 28.0, 0.9)
    place(hits, saw_stack((33, 40, 45), 3.2, attack=0.03, decay=1.6), 28.0, 0.6)
    fx += reverb(fx, 2.2, 0.3)
    hits += reverb(hits, 2.6, 0.25)
    mix = fx + groove * 0.95 + outro * 0.9 + hits
    mix = fade(mix, 30.4, 32.0)
    master(mix, os.path.join(HERE, "music-burn.wav"))


def pop(freq=1250, dur=0.09):
    """A soft UI "pop" for a chat bubble: a sine that drops in pitch."""
    t = tt(dur)
    f = freq * (1 + 0.45 * np.exp(-t / 0.012))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.028) * (1 - np.exp(-t / 0.0015)) * 0.45


def chime(dur=0.9):
    """A two-note notification chime."""
    out = np.zeros(int(dur * SR))
    for m, at in ((88, 0.0), (93, 0.085)):
        s = pluck(hz(m), dur - at) * 0.9
        i = int(at * SR)
        out[i:i + len(s)] += s[: len(out) - i]
    return out


def bot():
    """Moatpad Bot teaser (bot.html): 50 s at 120 BPM. Its UI cues (bubbles, taps, notifications, buy chips) come from
    sfx-bot.json, which render.mjs writes from the page, so the sounds land on the frames that show them."""
    import json
    total, beat = 50.0, 0.5
    n = int(total * SR)
    st = lambda x: np.stack([x, x], axis=1)
    with open(os.path.join(HERE, "sfx-bot.json")) as f:
        cues = json.load(f)

    # 0-6: a dark drone, the screen powering on at 2.0, the headline's notes, then a rush into the drop at 6.0
    fx = np.zeros((n, 2))
    place(fx, saw_stack((33, 40), 6.0, attack=2.5, decay=4.0, cutoff=900), 0.0, 0.5)
    for m in CHORDS[0] + (CHORDS[0][0] + 12,):
        place(fx, pad_note(hz(m), 5.6, attack=1.6, release=0.8, bright=0.4), 0.2, 0.9)
    place(fx, chime(1.4), 2.0, 0.55)
    for k, (m, at) in enumerate(((69, 2.3), (72, 2.75), (76, 3.2), (81, 3.65))):
        place(fx, pluck(hz(m), 1.2), at, 0.5, pan=-0.3 + 0.2 * k)
    place(fx, riser(2.2), 3.8, 0.7)
    place(fx, reverse_cymbal(1.0), 5.0, 0.6)
    place(fx, st(whoosh(0.7)), 5.3, 0.9)

    # 6-8 the title over a held chord; 8-42 the groove (24-30 drops to a break under the alerts); 42-44 a build
    title, _ = song(total, 120, 1, 6.0, [(0, 0, {"padbright", "sub"})])
    groove, _ = song(total, 120, 17, 8.0, [
        (0, 1, {"pad", "kick", "hat", "bass", "arp"}),
        (2, 4, {"pad", "kick", "hat", "hat16", "clap", "bass", "arp"}),
        (5, 7, {"padbright", "kick", "hat", "hat16", "clap", "bass", "bassoct", "arpup"}),
        (8, 9, {"pad", "sub", "arp"}),
        (10, 10, {"pad", "sub", "arp", "riser"}),
        (11, 13, {"padbright", "kick", "hat", "hat16", "clap", "bass", "arpup"}),
        (14, 16, {"pad", "kick", "hat", "clap", "bass", "arp"}),
    ])
    groove = fade(groove, 41.85, 42.05)
    build, _ = song(total, 120, 1, 42.0, [(0, 0, {"pad", "sub", "riser"})])
    build = fade(build, 43.9, 44.02)
    outro, _ = song(total, 120, 3, 44.0, [(0, 2, {"padbright", "sub", "arp"})])

    hits = np.zeros((n, 2))
    place(hits, st(impact(3.0)), 6.0, 1.15)  # the title
    place(hits, st(subdrop()), 6.0, 0.95)
    place(hits, saw_stack((33, 45, 52), 2.6, attack=0.03, decay=1.3), 6.0, 0.6)
    place(hits, st(impact(1.8)), 8.0, 0.55)
    place(hits, st(impact(1.8)), 17.0, 0.7)  # $MDOG is LIVE!
    place(hits, chime(1.2) * 0.8, 17.0, 0.5)
    for at, g in ((7.6, 0.7), (15.95, 0.45), (17.65, 0.95), (23.7, 0.55), (29.9, 0.7), (35.8, 0.6), (41.6, 0.6), (43.7, 0.7)):
        place(hits, st(whoosh(0.7)), at, g)  # the phone and the camera moving
    place(hits, st(impact(1.6)), 30.0, 0.5)
    place(hits, reverse_cymbal(1.2), 42.8, 0.6)
    place(hits, st(impact(3.4)), 44.0, 1.15)  # the outro title
    place(hits, st(subdrop()), 44.0, 0.9)
    place(hits, saw_stack((33, 40, 45), 3.2, attack=0.03, decay=1.6), 44.0, 0.55)

    ui = np.zeros((n, 2))
    for i, at in enumerate(sorted(cues["in"])):
        place(ui, pop(1150 + 90 * (i % 3)), at, 0.5, pan=-0.15)
    for at in cues["out"]:
        place(ui, pop(1650), at, 0.42, pan=0.2)
    for at in cues["taps"]:
        place(ui, tick(), at, 0.45, pan=0.1)
    for at in cues["notes"]:
        place(ui, chime(), at, 0.45, pan=0.15)
    for at in cues["chips"]:  # a buy pops out of the phone
        place(ui, pluck(hz(93), 0.5) + np.pad(pluck(hz(100), 0.42), (int(0.08 * SR), 0))[: int(0.5 * SR)], at, 0.4, pan=-0.2)
    ui += delay(ui, beat * 0.75, fb=0.25, mix=0.16, taps=2)

    fx += reverb(fx, 2.6, 0.32)
    hits += reverb(hits, 2.8, 0.25)
    ui += reverb(ui, 1.2, 0.12)
    mix = fx + title * 0.9 + groove * 0.85 + build * 0.8 + outro * 0.9 + hits + ui * 0.85
    mix = fade(mix, 48.6, 50.0)
    master(mix, os.path.join(HERE, "music-bot.wav"))

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        for name in sys.argv[1:]:
            globals()[name]()
        sys.exit(0)
    tour()
    live()
    burn()
    bot()
    if os.path.exists(os.path.join(HERE, "demo-app.json")):
        demo()
