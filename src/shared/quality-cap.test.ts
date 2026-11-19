import { describe, expect, it } from "vitest";
import {
  selectVideoStreamForQualityCap,
  summarizeAvailableQuality,
  type VideoStreamCandidate,
} from "./quality-cap.js";

const landscapeFormats: VideoStreamCandidate[] = [
  { formatId: "4k", width: 3840, height: 2160, fps: 60, vcodec: "vp9", tbr: 15000 },
  { formatId: "1080p30", width: 1920, height: 1080, fps: 30, vcodec: "avc1", tbr: 3500 },
  { formatId: "1080p60", width: 1920, height: 1080, fps: 60, vcodec: "vp9", tbr: 5500 },
  { formatId: "720p60", width: 1280, height: 720, fps: 60, vcodec: "vp9", tbr: 2400 },
  { formatId: "480p", width: 854, height: 480, fps: 30, vcodec: "avc1", tbr: 1000 },
  { formatId: "audio", width: 0, height: 0, vcodec: "none", tbr: 128 },
];

describe("selectVideoStreamForQualityCap", () => {
  it("caps 4K landscape videos at 1080p and prefers 60fps over 30fps", () => {
    const chosen = selectVideoStreamForQualityCap(landscapeFormats, 1080);
    expect(chosen).toMatchObject({
      formatId: "1080p60",
      shortEdge: 1080,
      fps: 60,
      below720pWarning: false,
    });
  });

  it("selects 720p when Quality Cap is 720", () => {
    const chosen = selectVideoStreamForQualityCap(landscapeFormats, 720);
    expect(chosen).toMatchObject({
      formatId: "720p60",
      shortEdge: 720,
      below720pWarning: false,
    });
  });

  it("matches Quality Cap against the short edge for vertical Shorts (1080x1920)", () => {
    const verticalFormats: VideoStreamCandidate[] = [
      { formatId: "short-1080", width: 1080, height: 1920, fps: 60, vcodec: "vp9" },
      { formatId: "short-720", width: 720, height: 1280, fps: 30, vcodec: "avc1" },
      { formatId: "short-480", width: 480, height: 854, fps: 30, vcodec: "avc1" },
    ];

    expect(selectVideoStreamForQualityCap(verticalFormats, 1080)).toMatchObject({
      formatId: "short-1080",
      width: 1080,
      height: 1920,
      shortEdge: 1080,
      below720pWarning: false,
    });

    expect(selectVideoStreamForQualityCap(verticalFormats, 720)).toMatchObject({
      formatId: "short-720",
      shortEdge: 720,
      below720pWarning: false,
    });

    expect(summarizeAvailableQuality(verticalFormats)).toEqual({
      maxShortEdge: 1080,
      availableQualityCaps: [720, 1080],
      below720pWarning: false,
      isVertical: true,
    });
  });

  it("falls back to highest available resolution with warning when source is below 720p", () => {
    const oldVideo: VideoStreamCandidate[] = [
      { formatId: "480p", width: 640, height: 480, fps: 30, vcodec: "avc1" },
      { formatId: "360p", width: 480, height: 360, fps: 30, vcodec: "avc1" },
    ];

    expect(selectVideoStreamForQualityCap(oldVideo, 1080)).toMatchObject({
      formatId: "480p",
      shortEdge: 480,
      below720pWarning: true,
    });

    expect(summarizeAvailableQuality(oldVideo)).toEqual({
      maxShortEdge: 480,
      availableQualityCaps: [],
      below720pWarning: true,
      isVertical: false,
    });
  });
});
