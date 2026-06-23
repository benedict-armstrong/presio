import { describe, it, expect } from "vitest";
import { computeSample } from "./clock";

describe("computeSample", () => {
  it("seeds offset and rtt directly from the first sample", () => {
    // t1=1000, t2=1100 -> rtt 100, midpoint 1050; serverTime 2000 -> offset 950
    expect(computeSample(1000, 1100, 2000, null)).toEqual({
      offsetMs: 950,
      rttMs: 100,
    });
  });

  it("smooths later samples with an EWMA (alpha 0.3)", () => {
    const prev = { offsetMs: 1000, rttMs: 100 };
    // sample: rtt 100, offset 950 -> within outlier bound
    const next = computeSample(1000, 1100, 2000, prev);
    // offset: 1000*0.7 + 950*0.3 = 985 ; rtt: 100*0.7 + 100*0.3 = 100
    expect(next.offsetMs).toBeCloseTo(985, 6);
    expect(next.rttMs).toBeCloseTo(100, 6);
  });

  it("rejects RTT outliers, returning the previous estimate unchanged", () => {
    const prev = { offsetMs: 1000, rttMs: 100 };
    // rtt = 1000 > 100*4 + 200 = 600 -> rejected
    const next = computeSample(0, 1000, 5000, prev);
    expect(next).toBe(prev);
  });

  it("accepts an RTT right at the outlier threshold", () => {
    const prev = { offsetMs: 0, rttMs: 100 };
    // rtt = 600 == threshold (not > 600) -> accepted
    const next = computeSample(0, 600, 600, prev);
    expect(next).not.toBe(prev);
  });
});
