import { describe, it, expect } from "vitest";
import { containedRect, EMPTY_RECT } from "./containedRect";

describe("containedRect", () => {
  it("fills the container when the aspect ratios match", () => {
    expect(containedRect(800, 600, 400, 300)).toEqual({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
    });
  });

  it("letterboxes (bars top and bottom) in a container taller than the page", () => {
    // 4:3 page in a 800x800 box -> 800x600 centred vertically.
    expect(containedRect(800, 800, 400, 300)).toEqual({
      left: 0,
      top: 100,
      width: 800,
      height: 600,
    });
  });

  it("pillarboxes (bars left and right) in a container wider than the page", () => {
    // 4:3 page in a 1000x600 box -> 800x600 centred horizontally.
    expect(containedRect(1000, 600, 400, 300)).toEqual({
      left: 100,
      top: 0,
      width: 800,
      height: 600,
    });
  });

  it("returns an empty rect when any dimension is missing", () => {
    // Happens before the container is laid out or the canvas is attached;
    // callers use the zero width to skip rendering the overlay entirely.
    expect(containedRect(0, 600, 400, 300)).toEqual(EMPTY_RECT);
    expect(containedRect(800, 0, 400, 300)).toEqual(EMPTY_RECT);
    expect(containedRect(800, 600, 0, 300)).toEqual(EMPTY_RECT);
    expect(containedRect(800, 600, 400, 0)).toEqual(EMPTY_RECT);
  });
});
