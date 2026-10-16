/**
 * Idempotent delivery. Every message has an event key; it is claimed in tg_sent (per chat) before
 * the send, so a repeated NOTIFY, a catch-up replay or a restart never sends it twice. A send that
 * Telegram refuses (or that never reached it) releases the claim; when a later attempt may get through
 * (no connection, a flood wait, an error on Telegram's side) the failure is remembered with the event it was
 * for, so the notifier's retry handles that event again for that one chat and key. A send that got no answer
 * after it went out (a timeout) may have been posted: it keeps its claim and is never sent again. A chat that blocked
 * or kicked the bot loses its subscriptions; a closed forum topic, or a group that lets nobody post for
 * now, only loses that one message. A basic group that became a supergroup has its rows moved to the new
 * chat id, and a deleted forum topic's alerts move to the General topic; either way the message is sent there once.
 */
import {
  clearTelegramThread,
  markSent,
  moveTelegramChat,
  removeBuybot,
  removeChatSubscriptions,
  unmarkSent,
  type HoldfastNotification,
  type Queryable,
} from "@holdfast/db";

import { TelegramError, type Keyboard, type TelegramApi } from "./telegram.js";

/**
 * "failed": not delivered, the claim released; or no answer after the send went out (it may have been posted), the claim kept.
 * "flooded": Telegram asked to wait (429) before posting in that chat again; the claim is released like "failed".
 * "topic_closed": the forum topic it was for is closed: not sent and not retried, and the chat keeps its alerts.
 * "no_rights": the group lets the bot post nothing right now (a night-mode lock, say): the same as "topic_closed".
 * "stopped": the notifier is shutting down: nothing was claimed or sent (the next start's catch-up has it).
 */
export type DeliveryResult = "sent" | "duplicate" | "failed" | "flooded" | "topic_closed" | "no_rights" | "unavailable" | "stopped";

/** Failed deliveries remembered for a retry at most: past that, the least recently tried one is given up. */
export const MAX_PENDING_FAILURES = 1_000;

export interface DeliveryMetrics {
  delivered(kind: string, result: DeliveryResult): void;
}

interface Logger {
  error(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

export interface OutboxOptions {
  metrics?: DeliveryMetrics;
  log?: Logger;
  /**
   * Chats the operator configured (the burn channel): when the bot cannot post there it is a setup error,
   * logged as one, and the chat keeps its claims released instead of being dropped like a user who blocked the bot.
   */
  operatorChats?: readonly number[];
  /** Shutdown: once it aborts, no delivery starts any more, and a send waiting out a flood wait stops waiting. */
  signal?: AbortSignal;
  now?: () => number;
}

/** A delivery that failed in a way a later attempt may fix (no connection, a flood wait, an error on Telegram's side). */
export interface PendingFailure {
  chatId: number;
  eventKey: string;
  /** The event the message was for: a retry handles it again, for this chat and key only. */
  event: HoldfastNotification;
  /** When it first failed. */
  since: number;
  /** Changes with every failure of it: `retried` tells by it whether the retry failed again. */
  seq: number;
}

/** One delivery (a message for one chat), as `PendingFailure`s and retries name it. */
export function deliveryId(chatId: number, eventKey: string): string {
  return `${chatId}:${eventKey}`;
}

export class Outbox {
  /** By delivery id, least recently failed first. */
  private readonly pending = new Map<string, PendingFailure>();
  private seq = 0;
  private unansweredSends = 0;
  private readonly now: () => number;

  constructor(
    private readonly db: Queryable,
    private readonly tg: Pick<TelegramApi, "sendMessage" | "floodWaitMs">,
    private readonly opts: OutboxOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Claim `eventKey` without sending: a lower milestone superseded by a higher one, a buy given up, or a message
   * claimed up front and sent later with `deliver(..., { claimed: true })`. With `kind`, a key claimed already counts
   * as a duplicate. `sentAs`: keys the same message was claimed under by an older version; a claim of one counts.
   */
  async claim(chatId: number, eventKey: string, kind?: string, sentAs?: readonly string[]): Promise<boolean> {
    const claimed = await markSent(this.db, chatId, eventKey, sentAs);
    if (!claimed && kind) this.opts.metrics?.delivered(kind, "duplicate");
    // Claimed: an earlier failure of that message is not retried any more.
    if (claimed) this.pending.delete(deliveryId(chatId, eventKey));
    return claimed;
  }

  /**
   * Sends the message unless `eventKey` was claimed already (`claimed`: this caller holds the claim).
   * `threadId`: the forum topic to post in. `event`: what the message is for; when the send fails in a way a
   * later attempt may fix, it is remembered for a retry (without one, the caller retries by itself).
   */
  async deliver(
    chatId: number,
    eventKey: string,
    html: string,
    kind: string,
    buttons?: Keyboard,
    opts: { claimed?: boolean; threadId?: number | null; event?: HoldfastNotification } = {},
  ): Promise<DeliveryResult> {
    if (this.opts.signal?.aborted) {
      // Shutting down: a claim the caller holds is released too, so the next start's catch-up can send it.
      if (opts.claimed) await unmarkSent(this.db, chatId, eventKey);
      this.opts.metrics?.delivered(kind, "stopped");
      return "stopped";
    }
    const id = deliveryId(chatId, eventKey);
    const earlier = this.pending.get(id)?.seq;
    const result = await this.attempt(chatId, { eventKey, html, buttons, event: opts.event }, opts.threadId ?? undefined, !opts.claimed);
    // Delivered, or refused in a way another attempt would not fix: an earlier failure of it is settled.
    if (this.pending.get(id)?.seq === earlier) this.pending.delete(id);
    this.opts.metrics?.delivered(kind, result);
    return result;
  }

  /** How many sends got no answer after they went out (Telegram may have posted them): they are never sent again. */
  get unanswered(): number {
    return this.unansweredSends;
  }

  /** Every failed delivery a retry may fix, least recently failed first. */
  pendingFailures(): PendingFailure[] {
    return [...this.pending.values()];
  }

  /**
   * The failed deliveries to retry now, least recently failed first, at most `limit`. A chat still in a
   * Telegram flood wait is left for a later run: a send there would fail at once, without a request.
   */
  retryDue(limit: number): PendingFailure[] {
    const due: PendingFailure[] = [];
    for (const f of this.pending.values()) {
      if (due.length >= limit) break;
      if ((this.tg.floodWaitMs?.(f.chatId) ?? 0) === 0) due.push(f);
    }
    return due;
  }

  /**
   * The retry of `f` (from `retryDue`) is over. Unless it failed again, it is forgotten: delivered, or no longer
   * due (an event too old, a chat that unsubscribed). True when it failed again.
   */
  retried(f: PendingFailure): boolean {
    const id = deliveryId(f.chatId, f.eventKey);
    const current = this.pending.get(id);
    if (current?.seq === f.seq) this.pending.delete(id);
    return current !== undefined && current.seq !== f.seq;
  }

  /**
   * The retry of `f` (from `retryDue`) could not be made: handling its event again failed. It goes last, like a
   * delivery that failed again, so the ones behind it are retried first next time (it is still given up with age).
   */
  postpone(f: PendingFailure): void {
    const id = deliveryId(f.chatId, f.eventKey);
    const current = this.pending.get(id);
    if (current?.seq !== f.seq) return;
    this.pending.delete(id);
    this.pending.set(id, { ...current, seq: ++this.seq });
  }

  private failed(chatId: number, m: Message): void {
    if (!m.event) return;
    const id = deliveryId(chatId, m.eventKey);
    const earlier = this.pending.get(id);
    // Moved to the end: the least recently failed delivery is retried (and given up) first.
    this.pending.delete(id);
    this.pending.set(id, { chatId, eventKey: m.eventKey, event: m.event, since: earlier?.since ?? this.now(), seq: ++this.seq });
    for (const [oldest, f] of this.pending) {
      if (this.pending.size <= MAX_PENDING_FAILURES) break;
      this.pending.delete(oldest);
      this.opts.log?.warn({ chatId: f.chatId, eventKey: f.eventKey, failedSince: f.since }, "too many failed deliveries to retry: the least recently tried one is given up");
    }
  }

  private async attempt(chatId: number, m: Message, threadId: number | undefined, claim: boolean, redirect = true): Promise<DeliveryResult> {
    const { eventKey, html, buttons } = m;
    if (claim && !(await markSent(this.db, chatId, eventKey))) return "duplicate";
    try {
      await this.tg.sendMessage(chatId, html, { buttons, threadId, signal: this.opts.signal });
      return "sent";
    } catch (err) {
      if (err instanceof TelegramError && err.threadNotFound && threadId !== undefined && redirect) {
        // The topic was deleted: what posted there goes to the General topic now, starting with this message (the claim is kept).
        const moved = await clearTelegramThread(this.db, chatId, threadId);
        this.opts.log?.info({ chatId, threadId, moved }, "forum topic deleted; its alerts go to the General topic now");
        return this.attempt(chatId, m, undefined, false, false);
      }
      if (err instanceof TelegramError && err.chatUnavailable) {
        if (this.opts.operatorChats?.includes(chatId)) {
          await unmarkSent(this.db, chatId, eventKey);
          this.opts.log?.error({ chatId, eventKey, reason: err.description }, "the bot cannot post in a configured chat (NOTIFIER_BURN_CHAT_ID): add it there as an admin");
          return "unavailable";
        }
        const removed = await removeChatSubscriptions(this.db, chatId);
        await removeBuybot(this.db, chatId);
        this.opts.log?.info({ chatId, removed, reason: err.description }, "chat unavailable; subscriptions removed");
        return "unavailable";
      }
      if (err instanceof TelegramError && err.maybeSent) {
        // Timed out (or cut off) after the request went out: Telegram may have posted it. Sending it again (a retry, the
        // next catch-up) could post it twice, or every minute while Telegram is slow: the claim is kept and it is given up.
        this.unansweredSends++;
        this.opts.log?.warn({ chatId, eventKey, err: err.message }, "no answer after the message was sent: it may have been delivered, and is not sent again");
        return "failed";
      }
      await unmarkSent(this.db, chatId, eventKey);
      if (err instanceof TelegramError && err.topicClosed) {
        // The group closed that topic, often for a while: the message is given up, the chat keeps its buy bot and alerts.
        this.opts.log?.debug({ chatId, threadId, eventKey }, "message not delivered: the forum topic is closed");
        return "topic_closed";
      }
      if (err instanceof TelegramError && err.noRights) {
        // Likely the whole group is locked for a while (night mode): the same. A bot muted for good is dropped on its my_chat_member update.
        this.opts.log?.debug({ chatId, threadId, eventKey }, "message not delivered: the group lets the bot post nothing right now");
        return "no_rights";
      }
      if (err instanceof TelegramError && err.migrateToChatId !== undefined && redirect) {
        // The claim was released first, so it is not moved with the others and the new id can claim it (a basic group has no topics).
        await moveTelegramChat(this.db, chatId, err.migrateToChatId);
        this.opts.log?.info({ chatId, to: err.migrateToChatId }, "group became a supergroup; its buy bot and alerts moved");
        return this.attempt(err.migrateToChatId, m, undefined, true, false);
      }
      // Only a failure a later attempt may fix is retried: another refusal would only fail again, every minute.
      if (!(err instanceof TelegramError) || err.transient) this.failed(chatId, m);
      if (err instanceof TelegramError && err.flooded) {
        this.opts.log?.warn({ chatId, eventKey, retryAfterSec: err.retryAfterSec }, "message not delivered: the chat is in a Telegram flood wait");
        return "flooded";
      }
      this.opts.log?.warn({ chatId, eventKey, err: err instanceof Error ? err.message : String(err) }, "message not delivered");
      return "failed";
    }
  }
}

/** What `attempt` sends, and the event it is for. */
interface Message {
  eventKey: string;
  html: string;
  buttons?: Keyboard;
  event?: HoldfastNotification;
}
