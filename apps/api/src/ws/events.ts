import { EventEmitter } from "node:events";
import { HOLDFAST_EVENTS_CHANNEL, parseNotification, type Db, type HoldfastNotification } from "@holdfast/db";

/** Source of change notifications that feed WebSocket pushes. */
export interface EventSource {
  /** `onReconnect` fires after the source was down: notifications in between are lost. */
  subscribe(handler: (n: HoldfastNotification) => void, opts?: { onReconnect?: () => void }): Promise<() => Promise<void>>;
}

/** pg LISTEN holdfast_events (published by the indexer, payout worker and launcher). */
export function pgEventSource(db: Db): EventSource {
  return {
    async subscribe(handler, opts) {
      return db.listen(
        HOLDFAST_EVENTS_CHANNEL,
        (payload) => {
          const n = parseNotification(payload);
          if (n) handler(n);
        },
        { onReconnect: opts?.onReconnect },
      );
    },
  };
}

/** In-process source for tests and dev tooling. */
export class MemoryEventSource implements EventSource {
  private readonly emitter = new EventEmitter();
  async subscribe(handler: (n: HoldfastNotification) => void, opts?: { onReconnect?: () => void }) {
    const onReconnect = () => opts?.onReconnect?.();
    this.emitter.on("event", handler);
    this.emitter.on("reconnect", onReconnect);
    return async () => {
      this.emitter.off("event", handler);
      this.emitter.off("reconnect", onReconnect);
    };
  }
  emit(n: HoldfastNotification): void {
    this.emitter.emit("event", n);
  }
  /** Pretend the source dropped and came back. */
  reconnect(): void {
    this.emitter.emit("reconnect");
  }
}
