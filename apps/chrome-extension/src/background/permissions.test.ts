import { describe, expect, it } from "vitest";

import { serverOriginPattern } from "./permissions";

describe("neural server permissions", () => {
  it("narrows an optional host request to one configured origin", () => {
    expect(serverOriginPattern("http://127.0.0.1:8765/v1")).toBe("http://127.0.0.1:8765/*");
    expect(serverOriginPattern("https://tts.example.test/api")).toBe("https://tts.example.test/*");
  });

  it("rejects non-network schemes", () => {
    expect(() => serverOriginPattern("file:///tmp/server")).toThrow(/HTTP or HTTPS/);
  });
});
