import { describe, expect, it } from "vitest";
import { buildDefaultClipFilename, sanitizeClipFilename } from "./filename.js";

describe("sanitizeClipFilename", () => {
  it("removes Windows-illegal characters and ensures .mp4 extension", () => {
    expect(sanitizeClipFilename('My: "Cool" / Video? *2026*')).toBe(
      "My_Cool_Video_2026.mp4",
    );
    expect(sanitizeClipFilename("already_named.MP4")).toBe("already_named.mp4");
  });

  it("handles Windows reserved device names safely", () => {
    expect(sanitizeClipFilename("CON")).toBe("CON_clip.mp4");
    expect(sanitizeClipFilename("nul.mp4")).toBe("nul_clip.mp4");
  });

  it("falls back when empty or only illegal chars", () => {
    expect(sanitizeClipFilename("???:::")).toBe("clip.mp4");
  });
});

describe("buildDefaultClipFilename", () => {
  it("builds {title}_{start}-{end}_{quality}.mp4 within safe length", () => {
    expect(
      buildDefaultClipFilename({
        title: "React Conf: Keynote / 2026!",
        startSeconds: 70,
        endSeconds: 150,
        effectiveQuality: 1080,
      }),
    ).toBe("React_Conf_Keynote_2026!_01m10s-02m30s_1080p.mp4");
  });

  it("truncates overly long titles while preserving timestamp and quality suffix", () => {
    const file = buildDefaultClipFilename({
      title: "A".repeat(250),
      startSeconds: 3723,
      endSeconds: 3800,
      effectiveQuality: 720,
    });
    expect(file.endsWith("_01h02m03s-01h03m20s_720p.mp4")).toBe(true);
    expect(file.length).toBeLessThanOrEqual(124);
  });
});
