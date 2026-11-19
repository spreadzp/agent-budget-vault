import { describe, expect, test } from "bun:test";
import { requiredEnv, signerFromKey } from "./env.mts";

describe("requiredEnv", () => {
  test("returns value when set", () => {
    process.env.__T_PEACH_X = "v";
    expect(requiredEnv("__T_PEACH_X")).toBe("v");
    delete process.env.__T_PEACH_X;
  });

  test("throws naming the missing var", () => {
    expect(() => requiredEnv("__T_PEACH_MISSING")).toThrow(/__T_PEACH_MISSING/);
  });
});

describe("signerFromKey", () => {
  const KEY = `0x${"1".repeat(64)}` as const;

  test("0x-prefixed and bare hex derive the same address", () => {
    expect(signerFromKey(KEY).address).toBe(signerFromKey(KEY.slice(2)).address);
  });

  test("rejects malformed key and never echoes it back", () => {
    const bad = "deadbeef-not-a-key";
    try {
      signerFromKey(bad);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(String(e)).toMatch(/invalid/i);
      expect(String(e)).not.toContain(bad);
    }
  });
});
