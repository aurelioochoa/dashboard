import { describe, expect, it } from "vitest";
import { sparkPoints } from "../src/sparkline.js";

const ys = (values: number[], minSpan?: number): number[] =>
  sparkPoints(values, minSpan).map(([, y]) => y);

describe("sparkPoints", () => {
  it("draws nothing for fewer than two points", () => {
    expect(sparkPoints([])).toEqual([]);
    expect(sparkPoints([50])).toEqual([]);
  });

  it("ignores non-finite values", () => {
    expect(sparkPoints([1, NaN, 2, Infinity]).length).toBe(2);
  });

  it("spreads x evenly from 0 to 100", () => {
    const xs = sparkPoints([1, 2, 3, 4, 5]).map(([x]) => x);
    expect(xs[0]).toBe(0);
    expect(xs[xs.length - 1]).toBe(100);
    expect(xs).toEqual([0, 25, 50, 75, 100]);
  });

  it("puts higher values higher on screen (smaller y)", () => {
    const [low, high] = ys([10, 90]);
    expect(high).toBeLessThan(low!);
  });

  it("draws a flat series as a horizontal line through the middle", () => {
    // The whole point of range scaling: a steady 82% RAM reading must not
    // fill the box, it must be a flat line.
    const flat = ys([82.3, 82.3, 82.3, 82.3]);
    expect(new Set(flat).size).toBe(1);
    expect(flat[0]).toBeCloseTo(10, 1); // vertical centre of the 20-unit box
  });

  it("does not magnify noise below minSpan", () => {
    // ±0.2 °C inside a 3-degree floor should stay visually subtle.
    const noisy = ys([55.0, 55.2, 54.9, 55.1], 3);
    expect(Math.max(...noisy) - Math.min(...noisy)).toBeLessThan(3);
  });

  it("uses the full height when the range exceeds minSpan", () => {
    const wide = ys([0, 100], 5);
    expect(Math.max(...wide) - Math.min(...wide)).toBeGreaterThan(14);
  });

  it("keeps every point inside the viewBox", () => {
    for (const y of ys([0, 50, 100, 25, 75])) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(20);
    }
  });

  it("handles negative values (temperature below zero)", () => {
    const points = ys([-5, 0, 5]);
    expect(points.length).toBe(3);
    expect(points[0]).toBeGreaterThan(points[2]!);
  });
});
