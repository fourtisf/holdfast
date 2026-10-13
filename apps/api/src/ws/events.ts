import { EventEmitter } from "node:events";
import { HOLDFAST_EVENTS_CHANNEL, parseNotification, type Db, type HoldfastNotification } from "@holdfast/db";

/** Source of change notifications that feed WebSocket pushes. */
export interface EventSource {
  subscribe(handler: (n: HoldfastNotification) => void): Promise<() => Promise<void>>;
}

/** pg LISTEN holdfast_events (published by the indexer, payout worker and launcher). */
export function pgEventSource(db: Db): EventSource {
  return {
    async subscribe(handler) {
      return db.listen(HOLDFAST_EVENTS_CHANNEL, (payload) => {
        const n = parseNotification(payload);
        if (n) handler(n);
      });
    },
  };
}

/** In-process source for tests and dev tooling. */
export class MemoryEventSource implements EventSource {
  private readonly emitter = new EventEmitter();
  async subscribe(handler: (n: HoldfastNotification) => void) {
    this.emitter.on("event", handler);
    return async () => {
      this.emitter.off("event", handler);
    };
  }
  emit(n: HoldfastNotification): void {
    this.emitter.emit("event", n);
  }
}
