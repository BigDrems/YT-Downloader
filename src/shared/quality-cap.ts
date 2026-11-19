import type { QualityCap } from "./schemas.js";

export interface VideoStreamCandidate {
  formatId: string;
  width: number;
  height: number;
  fps?: number | null;
  vcodec?: string | null;
  tbr?: number | null;
}

export interface SelectedVideoStream {
  formatId: string;
  width: number;
  height: number;
  shortEdge: number;
  fps: number | null;
  below720pWarning: boolean;
}

export interface QualitySummary {
  maxShortEdge: number;
  availableQualityCaps: QualityCap[];
  below720pWarning: boolean;
  isVertical: boolean;
}

export function getShortEdge(width: number, height: number): number {
  return Math.min(width, height);
}

function isUsableVideoStream(stream: VideoStreamCandidate): boolean {
  if (!stream.formatId) return false;
  if (!Number.isFinite(stream.width) || !Number.isFinite(stream.height)) return false;
  if (stream.width <= 0 || stream.height <= 0) return false;
  if (stream.vcodec && stream.vcodec.toLowerCase() === "none") return false;
  return true;
}

function compareStreamsDescending(
  a: VideoStreamCandidate,
  b: VideoStreamCandidate,
): number {
  const shortDiff = getShortEdge(b.width, b.height) - getShortEdge(a.width, a.height);
  if (shortDiff !== 0) return shortDiff;

  const fpsDiff = (b.fps ?? 0) - (a.fps ?? 0);
  if (fpsDiff !== 0) return fpsDiff;

  return (b.tbr ?? 0) - (a.tbr ?? 0);
}

export function summarizeAvailableQuality(
  streams: readonly VideoStreamCandidate[],
): QualitySummary | null {
  const usable = streams.filter(isUsableVideoStream);
  if (usable.length === 0) return null;

  const sorted = [...usable].sort(compareStreamsDescending);
  const highest = sorted[0]!;
  const maxShortEdge = getShortEdge(highest.width, highest.height);
  const availableQualityCaps: QualityCap[] = [];

  if (usable.some((s) => getShortEdge(s.width, s.height) >= 720)) {
    availableQualityCaps.push(720);
  }
  if (usable.some((s) => getShortEdge(s.width, s.height) >= 1080)) {
    availableQualityCaps.push(1080);
  }

  return {
    maxShortEdge,
    availableQualityCaps,
    below720pWarning: maxShortEdge < 720,
    isVertical: highest.height > highest.width,
  };
}

export function selectVideoStreamForQualityCap(
  streams: readonly VideoStreamCandidate[],
  qualityCap: QualityCap,
): SelectedVideoStream | null {
  const usable = streams.filter(isUsableVideoStream);
  if (usable.length === 0) return null;

  const hardCap = Math.min(qualityCap, 1080);
  const withinCap = usable.filter((s) => getShortEdge(s.width, s.height) <= hardCap);

  const chosen =
    withinCap.length > 0
      ? [...withinCap].sort(compareStreamsDescending)[0]!
      : [...usable].sort(
          (a, b) => getShortEdge(a.width, a.height) - getShortEdge(b.width, b.height),
        )[0]!;

  const shortEdge = getShortEdge(chosen.width, chosen.height);
  return {
    formatId: chosen.formatId,
    width: chosen.width,
    height: chosen.height,
    shortEdge,
    fps: chosen.fps ?? null,
    below720pWarning: shortEdge < 720,
  };
}
