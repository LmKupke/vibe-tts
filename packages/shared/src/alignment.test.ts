import { describe, expect, it } from "vitest";

import { findAlignmentAtTime, validateAlignment } from "./alignment";

describe("alignment validation", () => {
  it("accepts ordered source-backed word timing", () => {
    const result = validateAlignment("Hello world", [
      { text: "Hello", charStart: 0, charEnd: 5, startMs: 0, endMs: 400 },
      { text: "world", charStart: 6, charEnd: 11, startMs: 450, endMs: 900 },
    ]);
    expect(result).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it("rejects overlapping and out-of-range entries", () => {
    const result = validateAlignment("short", [
      { text: "short", charStart: 0, charEnd: 5, startMs: 10, endMs: 100 },
      { text: "bad", charStart: 4, charEnd: 7, startMs: 90, endMs: 80 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/exceeds|overlap|reversed/);
  });
});

describe("audio-time lookup", () => {
  const entries = [
    { text: "one", charStart: 0, charEnd: 3, startMs: 0, endMs: 200 },
    { text: "two", charStart: 4, charEnd: 7, startMs: 250, endMs: 500 },
    { text: "three", charStart: 8, charEnd: 13, startMs: 520, endMs: 900 },
  ];

  it("uses an end-exclusive binary search", () => {
    expect(findAlignmentAtTime(entries, 0)?.text).toBe("one");
    expect(findAlignmentAtTime(entries, 199)?.text).toBe("one");
    expect(findAlignmentAtTime(entries, 200)).toBeUndefined();
    expect(findAlignmentAtTime(entries, 520)?.text).toBe("three");
    expect(findAlignmentAtTime(entries, 900)).toBeUndefined();
  });
});
