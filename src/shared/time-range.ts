import type { ResolvedTimeRange } from "./schemas.js";

export const MIN_CLIP_DURATION_SECONDS = 1;
export const LONG_CLIP_WARNING_SECONDS = 30 * 60;

export function parseTimestampInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const secs = Number.parseInt(trimmed, 10);
    return Number.isSafeInteger(secs) && secs >= 0 ? secs : null;
  }

  const parts = trimmed.split(":");
  if (parts.length !== 2 && parts.length !== 3) {
    return null;
  }

  if (!parts.every((part) => /^\d{1,2}$/.test(part))) {
    return null;
  }

  if (parts.length === 2) {
    const minutes = Number.parseInt(parts[0]!, 10);
    const seconds = Number.parseInt(parts[1]!, 10);
    if (seconds >= 60) return null;
    return minutes * 60 + seconds;
  }

  const hours = Number.parseInt(parts[0]!, 10);
  const minutes = Number.parseInt(parts[1]!, 10);
  const seconds = Number.parseInt(parts[2]!, 10);
  if (minutes >= 60 || seconds >= 60) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

export function formatTimestamp(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

export function formatFilenameTimestamp(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}h${mm}m${ss}s`;
  }
  return `${mm}m${ss}s`;
}

export type ResolveTimeRangeResult =
  | {
      ok: true;
      timeRange: ResolvedTimeRange;
      clampedEnd: boolean;
      longClipWarning: boolean;
      notices: string[];
    }
  | {
      ok: false;
      code: "INVALID_TIME_RANGE";
      message: string;
    };

export function resolveTimeRange(input: {
  startSeconds?: number;
  endSeconds?: number;
  durationSeconds: number;
}): ResolveTimeRangeResult {
  const duration = Math.floor(input.durationSeconds);
  if (!Number.isFinite(duration) || duration < MIN_CLIP_DURATION_SECONDS) {
    return {
      ok: false,
      code: "INVALID_TIME_RANGE",
      message: "Source Video duration is too short to clip.",
    };
  }

  const start = input.startSeconds === undefined ? 0 : Math.floor(input.startSeconds);
  let end = input.endSeconds === undefined ? duration : Math.floor(input.endSeconds);
  const notices: string[] = [];
  let clampedEnd = false;

  if (!Number.isFinite(start) || start < 0) {
    return {
      ok: false,
      code: "INVALID_TIME_RANGE",
      message: "Start time must be 00:00 or greater.",
    };
  }

  if (!Number.isFinite(end) || end < 0) {
    return {
      ok: false,
      code: "INVALID_TIME_RANGE",
      message: "End time must be 00:00 or greater.",
    };
  }

  if (end > duration) {
    end = duration;
    clampedEnd = true;
    notices.push(
      `End time exceeded video duration and was clamped to ${formatTimestamp(duration)}.`,
    );
  }

  if (start >= duration) {
    return {
      ok: false,
      code: "INVALID_TIME_RANGE",
      message: `Start time (${formatTimestamp(start)}) must be before the video ends (${formatTimestamp(duration)}).`,
    };
  }

  if (start >= end) {
    return {
      ok: false,
      code: "INVALID_TIME_RANGE",
      message: "Start time must be strictly earlier than end time.",
    };
  }

  const clipDurationSeconds = end - start;
  if (clipDurationSeconds < MIN_CLIP_DURATION_SECONDS) {
    return {
      ok: false,
      code: "INVALID_TIME_RANGE",
      message: `Clip duration must be at least ${MIN_CLIP_DURATION_SECONDS} second.`,
    };
  }

  const longClipWarning = clipDurationSeconds > LONG_CLIP_WARNING_SECONDS;
  if (longClipWarning) {
    notices.push(
      `Clip is ${formatTimestamp(clipDurationSeconds)} long (over 30 minutes); local re-encoding may take several minutes.`,
    );
  }

  return {
    ok: true,
    timeRange: {
      startSeconds: start,
      endSeconds: end,
      clipDurationSeconds,
    },
    clampedEnd,
    longClipWarning,
    notices,
  };
}
