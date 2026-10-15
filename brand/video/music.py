"""Original soundtracks for the promo videos, synthesized from scratch (no samples, no third-party music).

    python3 brand/video/music.py            # writes brand/video/music-tour.wav (60 s) and music-live.wav (17 s)

Cinematic electronic in A minor: warm detuned pads, a sub bass ducked by the kick, plucked arpeggios through a
dotted-eighth delay, hats and claps, risers and impacts on the cuts. Every section boundary lands on a scene change
of tour.html / ad.html?v=live. Loudness is normalized afterwards with ffmpeg (loudnorm) when the audio is muxed.
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


# ---- live: 120 BPM, drop at 5.6 s on "MOATPAD IS LIVE" (ad.html?v=live) --------------------------------------
def live():
    total = 17.0
    bar = 2.0
    drop = 5.6
    S = [
        (0, 7, {"pad", "kick", "hat", "hat16", "clap", "bass", "bassoct", "arpup"}),
    ]
    mix, _ = song(total, 120, 6, drop, [(0, 3, S[0][2]), (4, 5, {"padbright", "sub", "arp"})])
    intro = np.zeros_like(mix)
    for m in CHORDS[0] + (CHORDS[0][0] + 12,):
        place(intro, pad_note(hz(m), drop - 0.3, attack=1.5, release=0.6), 0.0, 1.2)
    for k, at in enumerate((2.6, 3.6, 4.6)):  # countdown hits, the riser climbing under them
        place(intro, np.stack([impact(1.0) * (0.55 + 0.15 * k)] * 2, axis=1), at)
    place(intro, riser(3.0), 2.6, 0.9)
    intro += reverb(intro, 2.0, 0.35)
    mix = mix + intro
    place(mix, np.stack([impact(3.0)] * 2, axis=1), drop, 1.1)
    mix = fade(mix, 14.8, 17.0)
    master(mix, os.path.join(HERE, "music-live.wav"))


if __name__ == "__main__":
    tour()
    live()
