import { describe, expect, it } from "vitest";
import { normalizeYouTubeUrl, parseYouTubeTimeParam } from "./youtube-url.js";

describe("parseYouTubeTimeParam", () => {
  it("parses raw seconds and 's' suffix", () => {
    expect(parseYouTubeTimeParam("90")).toBe(90);
    expect(parseYouTubeTimeParam("90s")).toBe(90);
    expect(parseYouTubeTimeParam("0")).toBe(0);
  });

  it("parses h/m/s combinations", () => {
    expect(parseYouTubeTimeParam("1m30s")).toBe(90);
    expect(parseYouTubeTimeParam("1h2m3s")).toBe(3723);
    expect(parseYouTubeTimeParam("2m")).toBe(120);
  });

  it("returns null for invalid inputs", () => {
    expect(parseYouTubeTimeParam("")).toBeNull();
    expect(parseYouTubeTimeParam("abc")).toBeNull();
    expect(parseYouTubeTimeParam("-10")).toBeNull();
  });
});

describe("normalizeYouTubeUrl", () => {
  it("accepts standard watch URLs", () => {
    const res = normalizeYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(res).toEqual({
      ok: true,
      videoId: "dQw4w9WgXcQ",
      canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      initialStartSeconds: null,
      strippedPlaylist: false,
    });
  });

  it("accepts youtu.be, Shorts, live VODs, and protocol-less URLs", () => {
    expect(normalizeYouTubeUrl("youtu.be/dQw4w9WgXcQ?t=42")).toMatchObject({
      ok: true,
      videoId: "dQw4w9WgXcQ",
      initialStartSeconds: 42,
    });
    expect(
      normalizeYouTubeUrl("https://www.youtube.com/shorts/abcDEF12345"),
    ).toMatchObject({
      ok: true,
      videoId: "abcDEF12345",
      canonicalUrl: "https://www.youtube.com/watch?v=abcDEF12345",
    });
    expect(
      normalizeYouTubeUrl("https://m.youtube.com/live/abcDEF12345?t=1m15s"),
    ).toMatchObject({
      ok: true,
      videoId: "abcDEF12345",
      initialStartSeconds: 75,
    });
  });

  it("strips &list= on single-video URLs and preserves &t=", () => {
    const res = normalizeYouTubeUrl(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123456&index=3&t=1m30s",
    );
    expect(res).toEqual({
      ok: true,
      videoId: "dQw4w9WgXcQ",
      canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      initialStartSeconds: 90,
      strippedPlaylist: true,
    });
  });

  it("rejects pure playlist URLs", () => {
    const res = normalizeYouTubeUrl(
      "https://www.youtube.com/playlist?list=PL1234567890",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("PLAYLIST_UNSUPPORTED");
    }
  });

  it("rejects non-YouTube URLs and malformed inputs", () => {
    expect(normalizeYouTubeUrl("https://vimeo.com/12345").ok).toBe(false);
    expect(normalizeYouTubeUrl("not a url").ok).toBe(false);
    expect(normalizeYouTubeUrl("https://www.youtube.com/watch?v=short").ok).toBe(
      false,
    );
  });
});
