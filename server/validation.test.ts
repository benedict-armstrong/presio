import { describe, it, expect } from "vitest";
import { isValidHttpsUrl, isValidSlideNumber } from "./validation.js";

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
