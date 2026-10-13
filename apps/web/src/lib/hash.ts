/** FNV-1a 32-bit hash. Deterministic and fast; used for visual seeds only (never security). */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG seeded by a 32-bit integer; returns floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MascotPalette {
  hue: number;
  body: string;
  bodyDark: string;
  belly: string;
  bgFrom: string;
  bgTo: string;
  accent: string;
  eyes: "round" | "happy" | "wink";
  crest: "frond" | "sprout" | "curl" | "none";
  cheeks: boolean;
}

/** Derive a stable mascot palette and features from a mint (or any string). */
export function mascotPalette(seed: string): MascotPalette {
  const rand = seededRandom(hashString(seed));
  const hue = Math.floor(rand() * 360);
  const bgHue = (hue + 150 + Math.floor(rand() * 60)) % 360;
  const accentHue = (hue + 90 + Math.floor(rand() * 40)) % 360;
  const sat = 62 + Math.floor(rand() * 20);
  const eyes = (["round", "happy", "wink"] as const)[Math.floor(rand() * 3)] ?? "round";
  const crest = (["frond", "sprout", "curl", "none"] as const)[Math.floor(rand() * 4)] ?? "frond";
  return {
    hue,
    body: `hsl(${hue} ${sat}% 62%)`,
    bodyDark: `hsl(${hue} ${sat}% 42%)`,
    belly: `hsl(${hue} ${Math.max(40, sat - 20)}% 80%)`,
    bgFrom: `hsl(${bgHue} 45% 22%)`,
    bgTo: `hsl(${(bgHue + 40) % 360} 50% 12%)`,
    accent: `hsl(${accentHue} 75% 60%)`,
    eyes,
    crest,
    cheeks: rand() > 0.35,
  };
}
