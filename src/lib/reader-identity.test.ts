import { describe, expect, it } from "vitest";
import { hashReaderIp } from "./reader-identity";

describe("hashReaderIp", () => {
  it("is a stable 64-char hex HMAC that differs per IP and per secret", () => {
    const a = hashReaderIp("1.2.3.4", "s1");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashReaderIp("1.2.3.4", "s1")).toBe(a);
    expect(hashReaderIp("1.2.3.5", "s1")).not.toBe(a);
    expect(hashReaderIp("1.2.3.4", "s2")).not.toBe(a);
  });

  it("returns null without a secret and never returns the raw IP", () => {
    expect(hashReaderIp("1.2.3.4", "")).toBeNull();
    expect(hashReaderIp("1.2.3.4", "s1")).not.toContain("1.2.3.4");
  });
});
