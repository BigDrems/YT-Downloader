import { describe, expect, it } from "vitest";
import {
  formatFilenameTimestamp,
  formatTimestamp,
  parseTimestampInput,
  resolveTimeRange,
} from "./time-range.js";

describe("parseTimestampInput", () => {
  it("parses raw seconds, MM:SS, and HH:MM:SS", () => {
    expect(parseTimestampInput("0")).toBe(0);
    expect(parseTimestampInput("90")).toBe(90);
    expect(parseTimestampInput("1:30")).toBe(90);
    expect(parseTimestampInput("01:05")).toBe(65);
    expect(parseTimestampInput("01:02:03")).toBe(3723);
  });

  it("rejects decimals, negatives, and out-of-range clock fields", () => {
    expect(parseTimestampInput("01:10.5")).toBeNull();
    expect(parseTimestampInput("-5")).toBeNull();
    expect(parseTimestampInput("01:60")).toBeNull();
    expect(parseTimestampInput("01:60:00")).toBeNull();
    expect(parseTimestampInput("abc")).toBeNull();
  });
});

describe("formatTimestamp & formatFilenameTimestamp", () => {
  it("formats MM:SS under an hour and HH:MM:SS at or above an hour", () => {
    expect(formatTimestamp(65)).toBe("01:05");
    expect(formatTimestamp(3723)).toBe("01:02:03");
    expect(formatFilenameTimestamp(70)).toBe("01m10s");
    expect(formatFilenameTimestamp(3723)).toBe("01h02m03s");
  });
});

describe("resolveTimeRange", () => {
  it("defaults omitted bounds to full video duration", () => {
    const res = resolveTimeRange({ durationSeconds: 300 });
    expect(res).toEqual({
      ok: true,
      timeRange: { startSeconds: 0, endSeconds: 300, clipDurationSeconds: 300 },
      clampedEnd: false,
      longClipWarning: false,
      notices: [],
    });
  });

  it("clamps end beyond video duration with a notice", () => {
    const res = resolveTimeRange({
      startSeconds: 100,
      endSeconds: 600,
      durationSeconds: 582,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.clampedEnd).toBe(true);
      expect(res.timeRange.endSeconds).toBe(582);
      expect(res.notices[0]).toMatch(/clamped to 09:42/i);
    }
  });

  it("rejects start >= end and start >= duration", () => {
    expect(
      resolveTimeRange({ startSeconds: 50, endSeconds: 50, durationSeconds: 120 }).ok,
    ).toBe(false);
    expect(
      resolveTimeRange({ startSeconds: 60, endSeconds: 40, durationSeconds: 120 }).ok,
    ).toBe(false);
    expect(
      resolveTimeRange({ startSeconds: 120, durationSeconds: 120 }).ok,
    ).toBe(false);
  });

  it("emits a non-blocking warning for clips over 30 minutes", () => {
    const res = resolveTimeRange({
      startSeconds: 0,
      endSeconds: 1801,
      durationSeconds: 3600,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.longClipWarning).toBe(true);
      expect(res.notices.some((n) => n.includes("30 minutes"))).toBe(true);
    }
  });
});
