/**
 * Idempotent delivery. Every message has an event key; it is claimed in tg_sent (per chat) before
 * the send, so a repeated NOTIFY, a catch-up replay or a restart never sends it twice. A send that
 * Telegram refuses releases the claim, so a later replay may deliver it; a chat that blocked the
 * bot loses its subscriptions.
 */
import { markSent, removeBuybot, removeChatSubscriptions, unmarkSent, type Queryable } from "@holdfast/db";

import { TelegramError, type Keyboard, type TelegramApi } from "./telegram.js";

export type DeliveryResult = "sent" | "duplicate" | "failed" | "unavailable";

export interface DeliveryMetrics {
  delivered(kind: string, result: DeliveryResult): void;
}

interface Logger {
  warn(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
}

export class Outbox {
  constructor(
    private readonly db: Queryable,
    private readonly tg: Pick<TelegramApi, "sendMessage">,
    private readonly opts: { metrics?: DeliveryMetrics; log?: Logger } = {},
  ) {}

  /** Claim `eventKey` without sending (a lower milestone superseded by a higher one). */
  async claim(chatId: number, eventKey: string): Promise<boolean> {
    return markSent(this.db, chatId, eventKey);
  }

  async deliver(chatId: number, eventKey: string, html: string, kind: string, buttons?: Keyboard): Promise<DeliveryResult> {
    const result = await this.attempt(chatId, eventKey, html, buttons);
    this.opts.metrics?.delivered(kind, result);
    return result;
  }

  private async attempt(chatId: number, eventKey: string, html: string, buttons?: Keyboard): Promise<DeliveryResult> {
    if (!(await markSent(this.db, chatId, eventKey))) return "duplicate";
    try {
      await this.tg.sendMessage(chatId, html, buttons ? { buttons } : undefined);
      return "sent";
    } catch (err) {
      if (err instanceof TelegramError && err.chatUnavailable) {
        const removed = await removeChatSubscriptions(this.db, chatId);
        await removeBuybot(this.db, chatId);
        this.opts.log?.info({ chatId, removed, reason: err.description }, "chat unavailable; subscriptions removed");
        return "unavailable";
      }
      await unmarkSent(this.db, chatId, eventKey);
      this.opts.log?.warn({ chatId, eventKey, err: err instanceof Error ? err.message : String(err) }, "message not delivered");
      return "failed";
    }
  }
}
