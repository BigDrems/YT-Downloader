import { formatFilenameTimestamp } from "./time-range.js";

const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

const MAX_BASE_LENGTH = 120;

export function sanitizeFilenameSegment(raw: string, fallback = "clip"): string {
  const cleaned = raw
    .replace(/\.mp4$/i, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.\s]+|[_.\s]+$/g, "")
    .slice(0, MAX_BASE_LENGTH)
    .replace(/^[_.\s]+|[_.\s]+$/g, "");

  if (!cleaned) return fallback;

  if (WINDOWS_RESERVED_NAMES.has(cleaned.toUpperCase())) {
    return `${cleaned}_clip`;
  }

  return cleaned;
}

export function sanitizeClipFilename(rawName: string): string {
  return `${sanitizeFilenameSegment(rawName, "clip")}.mp4`;
}

export function buildDefaultClipFilename(params: {
  title: string;
  startSeconds: number;
  endSeconds: number;
  effectiveQuality: number;
}): string {
  const startTag = formatFilenameTimestamp(params.startSeconds);
  const endTag = formatFilenameTimestamp(params.endSeconds);
  const suffix = `_${startTag}-${endTag}_${params.effectiveQuality}p`;
  const maxTitleLen = Math.max(16, MAX_BASE_LENGTH - suffix.length);
  const safeTitle = sanitizeFilenameSegment(params.title, "youtube_clip")
    .slice(0, maxTitleLen)
    .replace(/[_.\s]+$/g, "");

  return `${safeTitle || "youtube_clip"}${suffix}.mp4`;
}
