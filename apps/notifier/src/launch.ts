/**
 * /launch: a coin launch filled in one question at a time in a private chat, then paid with a single
 * SOL transfer to a one-time deposit address (the same deposit launch as the website's). The bot never
 * holds a key: the wallet that pays becomes the creator, unless the user names another one.
 *
 * The questions and the validation of each answer are pure (`ask`, `applyText`, `applyButton`); the
 * flow class adds the side effects (drafts in the database, image upload, creating the launch).
 */
import { TRIGGER_OPTIONS_BPS, type LaunchQuote, type LaunchRequest, type Socials, type TriggerBps } from "@holdfast/core";
import { addTgLaunch, deleteDraft, getDraft, saveDraft, type Queryable } from "@holdfast/db";

import { ApiError, type MoatpadApi } from "./api.js";
import { isValidAddress } from "./address.js";
import { shortAddress, type Links } from "./format.js";
import { escapeHtml, type Keyboard, type TelegramApi, type TgMessage } from "./telegram.js";

export interface Reply {
  html: string;
  buttons?: Keyboard;
  preview?: boolean;
}

export type Step = "name" | "ticker" | "image" | "description" | "links" | "floor" | "devbuy" | "creator" | "confirm";

export interface LaunchDraft {
  name?: string;
  ticker?: string;
  imageUrl?: string;
  description?: string;
  socials?: Socials;
  triggerBps?: TriggerBps;
  devBuySol?: number;
  /** Unset: the wallet that pays becomes the creator. */
  creatorWallet?: string;
}

const ORDER: Step[] = ["name", "ticker", "image", "description", "links", "floor", "devbuy", "creator", "confirm"];
const TOTAL = ORDER.length - 1;
/** A draft untouched for this long is forgotten. */
export const DRAFT_TTL_MS = 6 * 3600_000;

const skip = { text: "Skip ⏭", callback_data: "l:skip" };
const cancelRow = [{ text: "✖️ Cancel", callback_data: "l:cancel" }];

function header(step: Step): string {
  return `<b>Step ${ORDER.indexOf(step) + 1} of ${TOTAL}</b>`;
}

/** The question for `step`, with its buttons. */
export function ask(step: Step, d: LaunchDraft, quote?: LaunchQuote | null): Reply {
  switch (step) {
    case "name":
      return { html: `🚀 <b>Let's launch your coin!</b>\n\n${header(step)}\nWhat is your coin's <b>name</b>?\n<i>Example: Moat Dog (max 32 characters)</i>`, buttons: [cancelRow] };
    case "ticker":
      return { html: `${header(step)}\nWhat is the <b>ticker</b>?\n<i>Example: MDOG (letters and numbers, max 10)</i>`, buttons: [cancelRow] };
    case "image":
      return { html: `${header(step)}\nSend your coin's <b>image</b> as a photo.\n<i>PNG, JPG, GIF or WEBP, max 5 MB. A square image looks best.</i>`, buttons: [[skip], cancelRow] };
    case "description":
      return { html: `${header(step)}\nWrite a short <b>description</b> for your coin.\n<i>Max 500 characters.</i>`, buttons: [[skip], cancelRow] };
    case "links":
      return {
        html: `${header(step)}\nSend your <b>links</b> in one message: X, Telegram and/or website.\n<i>Example: x.com/moatdog t.me/moatdog moatdog.com</i>`,
        buttons: [[skip], cancelRow],
      };
    case "floor":
      return {
        html: [
          `${header(step)}\nChoose your coin's <b>floor</b> 🛡`,
          "When the price falls this far below its all-time high, the coin's vault buys back automatically.",
          "<i>Tight defends small dips early. Loose leaves more room to move. You can't change it later.</i>",
        ].join("\n\n"),
        buttons: [
          [
            { text: "15% · Tight", callback_data: "l:floor:1500" },
            { text: "25% · Balanced ⭐", callback_data: "l:floor:2500" },
            { text: "35% · Loose", callback_data: "l:floor:3500" },
          ],
          cancelRow,
        ],
      };
    case "devbuy":
      return {
        html: `${header(step)}\nDo you want a <b>dev buy</b>?\nYou buy your own coin in the launch transaction, so no sniper gets in before you.\n<i>Tap an amount, or type one (0 to 10 SOL).</i>`,
        buttons: [
          [
            { text: "No dev buy", callback_data: "l:dev:0" },
            { text: "0.1 SOL", callback_data: "l:dev:0.1" },
          ],
          [
            { text: "0.5 SOL", callback_data: "l:dev:0.5" },
            { text: "1 SOL", callback_data: "l:dev:1" },
          ],
          cancelRow,
        ],
      };
    case "creator":
      return {
        html: [
          `${header(step)}\nWho receives the <b>creator fees</b>? 💸`,
          "The creator earns 15% of every trading fee of the coin and claims it on moatpad.fun.",
          "Tap the button to use the wallet you pay from, or send another wallet address.",
          "<i>Paying from an exchange? Then send your own wallet address here.</i>",
        ].join("\n\n"),
        buttons: [[{ text: "✅ The wallet I pay from", callback_data: "l:payer" }], cancelRow],
      };
    case "confirm":
      return summary(d, quote ?? null);
  }
}

function socialsLine(s: Socials | undefined): string {
  if (!s) return "none";
  const parts = [s.x && `X`, s.telegram && `Telegram`, s.website && `Website`].filter(Boolean);
  return parts.length ? parts.join(", ") : "none";
}

/** The final check before paying. */
export function summary(d: LaunchDraft, quote: LaunchQuote | null): Reply {
  const lines = [
    "<b>Ready to launch? Check your coin:</b>",
    "",
    `🪙 <b>${escapeHtml(d.name ?? "")}</b> ($${escapeHtml(d.ticker ?? "")})`,
    `🖼 Image: ${d.imageUrl ? "added" : "none"}`,
    `📝 Description: ${d.description ? escapeHtml(d.description.length > 80 ? `${d.description.slice(0, 80)}…` : d.description) : "none"}`,
    `🔗 Links: ${socialsLine(d.socials)}`,
    `🛡 Floor: ${((d.triggerBps ?? 2500) / 100).toFixed(0)}% below the all-time high`,
    `🛒 Dev buy: ${d.devBuySol ? `${d.devBuySol} SOL` : "none"}`,
    `💸 Creator fees go to: ${d.creatorWallet ? `<code>${escapeHtml(shortAddress(d.creatorWallet))}</code>` : "the wallet you pay from"}`,
  ];
  if (quote) lines.push("", `💰 <b>Total to pay: ${quote.requiredSol} SOL</b>`, "<i>Launch cost + dev buy. Anything left over is refunded.</i>");
  return {
    html: lines.join("\n"),
    buttons: [[{ text: "🚀 Launch my coin", callback_data: "l:go" }], [{ text: "✏️ Start over", callback_data: "l:restart" }, ...cancelRow]],
  };
}

export type Applied = { ok: true; data: LaunchDraft } | { ok: false; error: string };

const X_HOSTS = ["x.com", "twitter.com"];
const TG_HOSTS = ["t.me", "telegram.me"];

/** "x.com/foo t.me/bar foo.com" → socials; null when something is not a link. */
export function parseLinks(text: string): Socials | null {
  const socials: Socials = {};
  for (const raw of text.split(/[\s,]+/).filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return null;
    }
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (!host.includes(".")) return null;
    if (X_HOSTS.includes(host)) socials.x = url.toString();
    else if (TG_HOSTS.includes(host)) socials.telegram = url.toString();
    else socials.website = url.toString();
  }
  return Object.keys(socials).length ? socials : null;
}

/** Validates a typed answer for `step`. */
export function applyText(step: Step, d: LaunchDraft, text: string): Applied {
  const t = text.trim();
  switch (step) {
    case "name":
      if (!t) return { ok: false, error: "Please type a name." };
      if (t.length > 32) return { ok: false, error: `That name is ${t.length} characters. Please keep it to 32 or less.` };
      return { ok: true, data: { ...d, name: t } };
    case "ticker": {
      const ticker = t.replace(/^\$/, "").toUpperCase();
      if (!/^[A-Z0-9]{1,10}$/.test(ticker)) return { ok: false, error: "A ticker is 1 to 10 letters or numbers, like MDOG." };
      return { ok: true, data: { ...d, ticker } };
    }
    case "image":
      return { ok: false, error: "Please send the image as a photo, or tap Skip." };
    case "description":
      if (t.length > 500) return { ok: false, error: `That description is ${t.length} characters. Please keep it to 500 or less.` };
      return { ok: true, data: { ...d, description: t || undefined } };
    case "links": {
      const socials = parseLinks(t);
      if (!socials) return { ok: false, error: "I couldn't read those links. Send them like: x.com/yourcoin t.me/yourcoin yourcoin.com" };
      return { ok: true, data: { ...d, socials } };
    }
    case "devbuy": {
      const n = Number(t.replace(/\s*sol$/i, "").replace(",", "."));
      if (!Number.isFinite(n) || n < 0 || n > 10) return { ok: false, error: "Type an amount from 0 to 10 SOL, like 0.25." };
      return { ok: true, data: { ...d, devBuySol: Math.round(n * 1e4) / 1e4 } };
    }
    case "creator":
      if (!isValidAddress(t)) return { ok: false, error: "That is not a Solana wallet address. Send the address, or tap the button to use the wallet you pay from." };
      return { ok: true, data: { ...d, creatorWallet: t } };
    case "floor":
      return { ok: false, error: "Please tap one of the floor buttons." };
    case "confirm":
      return { ok: false, error: "Tap 🚀 Launch my coin to continue, or ✏️ Start over." };
  }
}

/** Applies a pressed button ("l:floor:2500" → action "floor", value "2500") for `step`. */
export function applyButton(step: Step, d: LaunchDraft, action: string, value: string | undefined): Applied {
  if (action === "skip" && (step === "image" || step === "description" || step === "links")) return { ok: true, data: d };
  if (action === "floor" && step === "floor") {
    const bps = Number(value);
    if (!(TRIGGER_OPTIONS_BPS as readonly number[]).includes(bps)) return { ok: false, error: "Please choose 15%, 25% or 35%." };
    return { ok: true, data: { ...d, triggerBps: bps as TriggerBps } };
  }
  if (action === "dev" && step === "devbuy") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 10) return { ok: false, error: "Please choose an amount." };
    return { ok: true, data: { ...d, devBuySol: n } };
  }
  if (action === "payer" && step === "creator") {
    const { creatorWallet: _, ...rest } = d;
    return { ok: true, data: rest };
  }
  return { ok: false, error: "That button belongs to another step. Please answer the question above." };
}

export function nextStep(step: Step): Step {
  return ORDER[Math.min(ORDER.indexOf(step) + 1, ORDER.length - 1)]!;
}

export function toLaunchRequest(d: LaunchDraft): LaunchRequest {
  return {
    name: d.name ?? "",
    ticker: d.ticker ?? "",
    description: d.description,
    imageUrl: d.imageUrl,
    socials: d.socials,
    triggerBps: d.triggerBps ?? 2500,
    devBuySol: d.devBuySol || undefined,
    creatorWallet: d.creatorWallet,
  };
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface LaunchFlowDeps {
  db: Queryable;
  api: MoatpadApi;
  tg: Pick<TelegramApi, "downloadFile">;
  links: Links;
  now: () => number;
}

/** The side-effect half of /launch: drafts, uploads and creating the launch. Every method returns the reply. */
export class LaunchFlow {
  constructor(private readonly deps: LaunchFlowDeps) {}

  /** Whether `chatId` is in the middle of a launch (a fresh draft exists). */
  async active(chatId: number): Promise<boolean> {
    const draft = await getDraft(this.deps.db, chatId);
    return draft !== null && this.deps.now() - draft.updatedAt < DRAFT_TTL_MS;
  }

  async start(chatId: number, userId: number): Promise<Reply> {
    await saveDraft(this.deps.db, { chatId, userId, step: "name", data: {} });
    return ask("name", {});
  }

  async cancel(chatId: number): Promise<Reply> {
    const had = await deleteDraft(this.deps.db, chatId);
    return {
      html: had ? "Launch cancelled. Send /launch whenever you want to start again." : "Nothing to cancel. Send /launch to launch a coin.",
      buttons: [[{ text: "🚀 Launch a coin", callback_data: "m:launch" }]],
    };
  }

  private async load(chatId: number): Promise<{ step: Step; data: LaunchDraft; userId: number } | null> {
    const draft = await getDraft(this.deps.db, chatId);
    if (!draft || this.deps.now() - draft.updatedAt >= DRAFT_TTL_MS || !ORDER.includes(draft.step as Step)) return null;
    return { step: draft.step as Step, data: draft.data as LaunchDraft, userId: draft.userId };
  }

  private async advance(chatId: number, userId: number, step: Step, data: LaunchDraft): Promise<Reply> {
    const next = nextStep(step);
    await saveDraft(this.deps.db, { chatId, userId, step: next, data: data as Record<string, unknown> });
    if (next !== "confirm") return ask(next, data);
    const quote = await this.deps.api.quote(data.devBuySol ?? 0).catch(() => null);
    return ask("confirm", data, quote);
  }

  private retry(error: string, step: Step, data: LaunchDraft): Reply {
    const again = ask(step, data);
    return { html: `⚠️ ${escapeHtml(error)}\n\n${again.html}`, buttons: again.buttons };
  }

  /** A message in the private chat while a launch is being filled in (text or a photo). */
  async onMessage(chatId: number, msg: TgMessage): Promise<Reply | null> {
    const draft = await this.load(chatId);
    if (!draft) return null;
    const userId = msg.from?.id ?? draft.userId;
    const fileId = msg.photo?.length ? msg.photo[msg.photo.length - 1]!.file_id : msg.document?.mime_type?.startsWith("image/") ? msg.document.file_id : null;
    if (fileId) {
      if (draft.step !== "image") return this.retry("I'm not asking for an image right now.", draft.step, draft.data);
      const size = msg.photo?.length ? msg.photo[msg.photo.length - 1]!.file_size : msg.document?.file_size;
      if (size && size > MAX_IMAGE_BYTES) return this.retry("That image is bigger than 5 MB. Please send a smaller one.", "image", draft.data);
      try {
        const file = await this.deps.tg.downloadFile(fileId);
        const imageUrl = await this.deps.api.uploadImage(file.bytes, file.path.split("/").pop() || "image");
        return this.advance(chatId, userId, "image", { ...draft.data, imageUrl });
      } catch (err) {
        const reason = err instanceof ApiError ? err.message : "the upload failed";
        return this.retry(`I couldn't use that image (${reason}). Try another one, or tap Skip.`, "image", draft.data);
      }
    }
    const text = msg.text ?? msg.caption;
    if (!text) return this.retry("Please answer with text.", draft.step, draft.data);
    const applied = applyText(draft.step, draft.data, text);
    if (!applied.ok) return this.retry(applied.error, draft.step, draft.data);
    return this.advance(chatId, userId, draft.step, applied.data);
  }

  /** A pressed "l:..." button. */
  async onButton(chatId: number, userId: number, data: string): Promise<Reply> {
    const [, action = "", value] = data.split(":");
    if (action === "cancel") return this.cancel(chatId);
    if (action === "restart") return this.start(chatId, userId);
    const draft = await this.load(chatId);
    if (!draft) return { html: "This launch has expired. Send /launch to start a new one.", buttons: [[{ text: "🚀 Launch a coin", callback_data: "m:launch" }]] };
    if (action === "go") {
      if (draft.step !== "confirm") return this.retry("Please finish the steps first.", draft.step, draft.data);
      return this.submit(chatId, draft.data);
    }
    const applied = applyButton(draft.step, draft.data, action, value);
    if (!applied.ok) return this.retry(applied.error, draft.step, draft.data);
    return this.advance(chatId, userId, draft.step, applied.data);
  }

  private async submit(chatId: number, data: LaunchDraft): Promise<Reply> {
    let res;
    try {
      res = await this.deps.api.createLaunch(toLaunchRequest(data));
    } catch (err) {
      if (err instanceof ApiError) {
        const reason = err.status === 503 ? "Launches are paused right now. Please try again a bit later." : err.status === 429 ? "Too many launches at once. Please try again in a minute." : err.message;
        return { html: `⚠️ ${escapeHtml(reason)}`, buttons: [[{ text: "🔁 Try again", callback_data: "l:go" }], [{ text: "✏️ Start over", callback_data: "l:restart" }, ...cancelRow]] };
      }
      throw err;
    }
    await addTgLaunch(this.deps.db, res.launchId, chatId);
    await deleteDraft(this.deps.db, chatId);
    const minutes = Math.max(1, Math.round((res.expiresAt - this.deps.now()) / 60_000));
    return {
      html: [
        "💳 <b>Last step: send the SOL</b>",
        "",
        `Send exactly <b>${res.requiredSol} SOL</b> to this address:`,
        `<code>${escapeHtml(res.depositAddress)}</code>`,
        "<i>(tap the address to copy it)</i>",
        "",
        `• Send it from your own wallet (Phantom, Solflare, ...).${data.creatorWallet ? "" : " That wallet becomes the creator."}`,
        "• Anything above the amount is refunded.",
        `• This address expires in ${minutes} minutes.`,
        "",
        "I'll message you here the moment your coin is live. 🚀",
      ].join("\n"),
      buttons: [[{ text: "💳 Pay with QR / wallet on moatpad.fun", url: `${this.deps.links.webUrl}/pay/${res.launchId}` }]],
    };
  }
}
