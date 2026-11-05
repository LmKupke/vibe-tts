import { describe, expect, it, vi } from "vitest";

import { GenerationPrefetchQueue, StaleGenerationError } from "./prefetch-queue";

describe("generation prefetch queue", () => {
  it("keeps a bounded two-to-four item synthesis window", async () => {
    const loader = vi.fn((index: number) => Promise.resolve(`clip-${index}`));
    const queue = new GenerationPrefetchQueue<string>({ capacity: 99 });
    queue.fill(2, 20, loader);
    await Promise.resolve();

    expect(queue.capacity).toBe(4);
    expect(loader.mock.calls.map(([index]) => index)).toEqual([2, 3, 4, 5]);
    expect(queue.readyCount(2)).toBe(4);
  });

  it("aborts irrelevant work and rejects late results from an old generation", async () => {
    let resolveResult: ((value: string) => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const queue = new GenerationPrefetchQueue<string>();
    const pending = queue.get(
      0,
      (_index, signal) =>
        new Promise<string>((resolve) => {
          observedSignal = signal;
          resolveResult = resolve;
        }),
    );

    queue.beginGeneration();
    resolveResult?.("late clip");

    expect(observedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(StaleGenerationError);
  });
});
