export class StaleGenerationError extends Error {
  constructor() {
    super("The synthesis result belongs to a stale playback generation.");
    this.name = "StaleGenerationError";
  }
}

type EntryStatus = "pending" | "ready" | "error";

interface QueueEntry<T> {
  generation: number;
  controller: AbortController;
  status: EntryStatus;
  promise: Promise<T>;
}

export type QueueLoader<T> = (index: number, signal: AbortSignal) => Promise<T>;

export interface PrefetchQueueOptions {
  capacity?: number;
  onChange?: () => void;
}

/** A generation-scoped, abortable queue with a deliberately small look-ahead window. */
export class GenerationPrefetchQueue<T> {
  readonly #capacity: number;
  readonly #onChange: () => void;
  readonly #entries = new Map<number, QueueEntry<T>>();
  #generation = 0;

  constructor(options: PrefetchQueueOptions = {}) {
    this.#capacity = Math.min(4, Math.max(2, options.capacity ?? 3));
    this.#onChange = options.onChange ?? (() => undefined);
  }

  get capacity(): number {
    return this.#capacity;
  }

  get generation(): number {
    return this.#generation;
  }

  beginGeneration(): number {
    this.#generation += 1;
    for (const entry of this.#entries.values()) entry.controller.abort();
    this.#entries.clear();
    this.#onChange();
    return this.#generation;
  }

  fill(startIndex: number, itemCount: number, loader: QueueLoader<T>): void {
    const endIndex = Math.min(itemCount, startIndex + this.#capacity);
    const retained = new Set<number>();
    for (let index = startIndex; index < endIndex; index += 1) {
      retained.add(index);
      this.#ensure(index, loader);
    }
    for (const [index, entry] of this.#entries) {
      if (retained.has(index)) continue;
      entry.controller.abort();
      this.#entries.delete(index);
    }
    this.#onChange();
  }

  get(index: number, loader: QueueLoader<T>): Promise<T> {
    return this.#ensure(index, loader).promise;
  }

  discard(index: number): void {
    const entry = this.#entries.get(index);
    if (!entry) return;
    if (entry.status === "pending") entry.controller.abort();
    this.#entries.delete(index);
    this.#onChange();
  }

  readyCount(fromIndex = 0): number {
    let count = 0;
    for (const [index, entry] of this.#entries) {
      if (index >= fromIndex && entry.status === "ready") count += 1;
    }
    return count;
  }

  #ensure(index: number, loader: QueueLoader<T>): QueueEntry<T> {
    const existing = this.#entries.get(index);
    if (existing) return existing;

    const generation = this.#generation;
    const controller = new AbortController();
    const entry: QueueEntry<T> = {
      generation,
      controller,
      status: "pending",
      promise: Promise.resolve(undefined as T),
    };
    entry.promise = loader(index, controller.signal).then(
      (value) => {
        if (
          controller.signal.aborted ||
          generation !== this.#generation ||
          this.#entries.get(index) !== entry
        ) {
          throw new StaleGenerationError();
        }
        entry.status = "ready";
        this.#onChange();
        return value;
      },
      (error: unknown) => {
        entry.status = "error";
        this.#onChange();
        throw error;
      },
    );
    // Prefetched promises may reject before they become the active item. Mark the
    // rejection observed while preserving it for the eventual consumer.
    void entry.promise.catch(() => undefined);
    this.#entries.set(index, entry);
    return entry;
  }
}
