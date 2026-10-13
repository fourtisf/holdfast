import { notify, type HoldfastNotification, type Queryable } from "@holdfast/db";

/** Where per-transaction change notifications go (the API turns them into WebSocket pushes). */
export interface Publisher {
  /** Called inside the indexing transaction; `q` lets pg NOTIFY be delivered on commit. */
  publish(q: Queryable, events: readonly HoldfastNotification[]): Promise<void>;
}

/** pg `NOTIFY holdfast_events` with a JSON payload per event. */
export const pgPublisher: Publisher = {
  publish: (q, events) => notify(q, events),
};

/** Collects events in memory (tests, dry runs). */
export class MemoryPublisher implements Publisher {
  readonly events: HoldfastNotification[] = [];
  async publish(_q: Queryable, events: readonly HoldfastNotification[]): Promise<void> {
    this.events.push(...events);
  }
}
