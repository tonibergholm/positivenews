import { describe, expect, it } from "vitest";
import { clientIp } from "./client-ip";

const h = (o: Record<string, string>) => new Headers(o);

describe("clientIp", () => {
  it("prefers x-real-ip", () => {
    expect(clientIp(h({ "x-real-ip": "1.1.1.1", "x-forwarded-for": "9.9.9.9, 2.2.2.2" }))).toBe("1.1.1.1");
  });
  it("falls back to the last x-forwarded-for entry, not the spoofable first", () => {
    expect(clientIp(h({ "x-forwarded-for": "9.9.9.9, 8.8.8.8 , 2.2.2.2" }))).toBe("2.2.2.2");
  });
  it("returns unknown without headers or with blank values", () => {
    expect(clientIp(h({}))).toBe("unknown");
    expect(clientIp(h({ "x-real-ip": " ", "x-forwarded-for": " " }))).toBe("unknown");
  });
});
