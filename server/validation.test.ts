import { describe, it, expect } from "vitest";
import { isValidHttpsUrl, sanitizeSettings, isValidSlideNumber } from "./validation.js";

describe("isValidHttpsUrl", () => {
  it("accepts well-formed https URLs", () => {
    expect(isValidHttpsUrl("https://example.com/x.pdf")).toBe(true);
  });
  it("rejects http, data, and other schemes", () => {
    expect(isValidHttpsUrl("http://example.com/x.pdf")).toBe(false);
    expect(isValidHttpsUrl("data:application/pdf;base64,AAAA")).toBe(false);
    expect(isValidHttpsUrl("javascript:alert(1)")).toBe(false);
  });
  it("rejects garbage and non-strings", () => {
    expect(isValidHttpsUrl("not a url")).toBe(false);
    expect(isValidHttpsUrl("")).toBe(false);
    expect(isValidHttpsUrl(undefined)).toBe(false);
    expect(isValidHttpsUrl(42)).toBe(false);
  });
});

describe("sanitizeSettings", () => {
  it("passes through valid values", () => {
    expect(
      sanitizeSettings({ timerMode: "down", timerDuration: 600, timerThreshold: 60, notePrefix: "n:" })
    ).toEqual({ timerMode: "down", timerDuration: 600, timerThreshold: 60, notePrefix: "n:" });
  });
  it("coerces an unknown timerMode to null", () => {
    expect(sanitizeSettings({ timerMode: "sideways" }).timerMode).toBeNull();
  });
  it("nulls negative / non-finite durations", () => {
    const out = sanitizeSettings({ timerDuration: -5, timerThreshold: Infinity });
    expect(out.timerDuration).toBeNull();
    expect(out.timerThreshold).toBeNull();
  });
  it("defaults notePrefix to 'note:' and caps it at 100 chars", () => {
    expect(sanitizeSettings({}).notePrefix).toBe("note:");
    expect(sanitizeSettings({ notePrefix: "x".repeat(150) }).notePrefix).toHaveLength(100);
  });
});

describe("isValidSlideNumber", () => {
  it("accepts positive integers within the deck", () => {
    expect(isValidSlideNumber(1, 10)).toBe(true);
    expect(isValidSlideNumber(10, 10)).toBe(true);
  });
  it("rejects non-integers, < 1, and out-of-range", () => {
    expect(isValidSlideNumber(0, 10)).toBe(false);
    expect(isValidSlideNumber(-2, 10)).toBe(false);
    expect(isValidSlideNumber(1.5, 10)).toBe(false);
    expect(isValidSlideNumber(11, 10)).toBe(false);
    expect(isValidSlideNumber(NaN, 10)).toBe(false);
  });
  it("only enforces the lower bound when total is unknown", () => {
    expect(isValidSlideNumber(999, undefined)).toBe(true);
    expect(isValidSlideNumber(0, undefined)).toBe(false);
  });
});
