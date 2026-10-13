import { z } from "zod";
import { TRIGGER_OPTIONS_BPS, type LaunchRequest } from "@holdfast/core";

const httpUrl = z
  .string()
  .trim()
  .max(200)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL");

/** Accepts a profile URL on one of `hosts` or a bare handle; normalizes to the URL. */
function handleOrUrl(hosts: string[], handle: RegExp, base: string) {
  return z
    .string()
    .trim()
    .max(200)
    .transform((v, ctx) => {
      const h = v.replace(/^@/, "");
      if (handle.test(h)) return `${base}${h}`;
      try {
        const u = new URL(v);
        if ((u.protocol === "https:" || u.protocol === "http:") && hosts.includes(u.hostname.replace(/^www\./, ""))) return u.toString();
      } catch {
        // fall through
      }
      ctx.addIssue({ code: "custom", message: `must be a handle or a ${hosts[0]} URL` });
      return z.NEVER;
    });
}

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const LaunchRequestSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(32, "name must be at most 32 characters"),
    ticker: z
      .string()
      .trim()
      .transform((v) => v.replace(/^\$/, "").toUpperCase())
      .pipe(z.string().regex(/^[A-Z0-9]{1,10}$/, "ticker must be 1-10 characters A-Z / 0-9")),
    description: z.preprocess(emptyToUndefined, z.string().trim().max(500, "description must be at most 500 characters").optional()),
    imageUrl: z.preprocess(emptyToUndefined, httpUrl.optional()),
    socials: z
      .object({
        x: z.preprocess(emptyToUndefined, handleOrUrl(["x.com", "twitter.com"], /^[A-Za-z0-9_]{1,15}$/, "https://x.com/").optional()),
        telegram: z.preprocess(emptyToUndefined, handleOrUrl(["t.me", "telegram.me"], /^[A-Za-z0-9_]{5,32}$/, "https://t.me/").optional()),
        website: z.preprocess(emptyToUndefined, httpUrl.optional()),
      })
      .strict()
      .optional(),
    triggerBps: z.number().refine((v) => (TRIGGER_OPTIONS_BPS as readonly number[]).includes(v), "triggerBps must be 1500, 2500 or 3500"),
    devBuySol: z.number().min(0, "devBuySol must be ≥ 0").max(10, "devBuySol must be ≤ 10").optional(),
  })
  .strict();

export function parseLaunchRequest(body: unknown): LaunchRequest {
  const r = LaunchRequestSchema.parse(body);
  const socials = r.socials ? Object.fromEntries(Object.entries(r.socials).filter(([, v]) => v !== undefined)) : undefined;
  return { ...r, socials, triggerBps: r.triggerBps as LaunchRequest["triggerBps"] } as LaunchRequest;
}
