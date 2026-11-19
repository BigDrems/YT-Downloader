import {
  normalizeYouTubeUrl,
  summarizeAvailableQuality,
  type SourceVideo,
  type VideoStreamCandidate,
} from "../../shared/index.js";
import { ProcessExitError, runCommand } from "./process.js";

export type InspectErrorCode =
  | "INVALID_URL"
  | "PLAYLIST_UNSUPPORTED"
  | "LIVESTREAM_UNSUPPORTED"
  | "PRIVATE_OR_AUTH_REQUIRED"
  | "VIDEO_UNAVAILABLE"
  | "YTDLP_OUTDATED_OR_FAILED";

export class InspectSourceError extends Error {
  readonly code: InspectErrorCode;
  readonly httpStatus: 400 | 422 | 502;

  constructor(
    code: InspectErrorCode,
    message: string,
    httpStatus: 400 | 422 | 502 = 422,
  ) {
    super(message);
    this.name = "InspectSourceError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface InspectedSourceVideo {
  sourceVideo: SourceVideo;
  formats: VideoStreamCandidate[];
}

interface RawYtDlpFormat {
  format_id?: string;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  vcodec?: string | null;
  tbr?: number | null;
}

interface RawYtDlpInfo {
  id?: string;
  title?: string;
  uploader?: string | null;
  channel?: string | null;
  duration?: number | null;
  thumbnail?: string | null;
  is_live?: boolean | null;
  live_status?: string | null;
  formats?: RawYtDlpFormat[];
}

export function classifyYtDlpStderr(stderr: string): {
  code: InspectErrorCode;
  message: string;
  httpStatus: 422 | 502;
} {
  const lower = stderr.toLowerCase();

  if (
    lower.includes("private video") ||
    lower.includes("members-only") ||
    lower.includes("join this channel") ||
    lower.includes("sign in to confirm your age") ||
    lower.includes("login required") ||
    lower.includes("authentication")
  ) {
    return {
      code: "PRIVATE_OR_AUTH_REQUIRED",
      message:
        "This video is private, members-only, or requires YouTube sign-in/age verification, which is not supported in v1.",
      httpStatus: 422,
    };
  }

  if (
    lower.includes("live event will begin") ||
    lower.includes("premieres in") ||
    lower.includes("is live")
  ) {
    return {
      code: "LIVESTREAM_UNSUPPORTED",
      message:
        "Active or upcoming livestreams are not supported. Wait until the archived VOD is available.",
      httpStatus: 422,
    };
  }

  if (
    lower.includes("video unavailable") ||
    lower.includes("this video has been removed") ||
    lower.includes("copyright claim")
  ) {
    return {
      code: "VIDEO_UNAVAILABLE",
      message: "This YouTube video is unavailable or has been removed.",
      httpStatus: 422,
    };
  }

  if (
    lower.includes("unable to extract") ||
    lower.includes("signature extraction failed") ||
    lower.includes("nsig extraction failed") ||
    lower.includes("http error 403")
  ) {
    return {
      code: "YTDLP_OUTDATED_OR_FAILED",
      message:
        "yt-dlp could not read this video from YouTube. Try updating yt-dlp (e.g., `yt-dlp -U` or `winget upgrade yt-dlp.yt-dlp`).",
      httpStatus: 502,
    };
  }

  return {
    code: "YTDLP_OUTDATED_OR_FAILED",
    message: stderr.split(/\r?\n/).filter(Boolean).pop() ?? "yt-dlp failed to inspect this video.",
    httpStatus: 502,
  };
}

export async function inspectSourceVideo(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<InspectedSourceVideo> {
  const normalized = normalizeYouTubeUrl(rawUrl);
  if (!normalized.ok) {
    throw new InspectSourceError(normalized.code, normalized.message, 400);
  }

  let stdout: string;
  try {
    const result = await runCommand(
      "yt-dlp",
      [
        "--dump-single-json",
        "--no-playlist",
        "--no-warnings",
        "--skip-download",
        normalized.canonicalUrl,
      ],
      { signal },
    );
    stdout = result.stdout;
  } catch (err) {
    if (err instanceof ProcessExitError) {
      const classified = classifyYtDlpStderr(err.stderr);
      throw new InspectSourceError(
        classified.code,
        classified.message,
        classified.httpStatus,
      );
    }
    throw err;
  }

  let info: RawYtDlpInfo;
  try {
    info = JSON.parse(stdout) as RawYtDlpInfo;
  } catch {
    throw new InspectSourceError(
      "YTDLP_OUTDATED_OR_FAILED",
      "Received invalid metadata JSON from yt-dlp.",
      502,
    );
  }

  if (
    info.is_live === true ||
    info.live_status === "is_live" ||
    info.live_status === "is_upcoming"
  ) {
    throw new InspectSourceError(
      "LIVESTREAM_UNSUPPORTED",
      "Active or upcoming livestreams are not supported. Only archived livestream VODs can be clipped.",
      422,
    );
  }

  const durationSeconds = Math.floor(info.duration ?? 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1) {
    throw new InspectSourceError(
      "VIDEO_UNAVAILABLE",
      "Could not determine a valid duration for this Source Video.",
      422,
    );
  }

  const formats: VideoStreamCandidate[] = (info.formats ?? [])
    .filter(
      (f): f is RawYtDlpFormat & { format_id: string; width: number; height: number } =>
        Boolean(f.format_id) &&
        typeof f.width === "number" &&
        typeof f.height === "number" &&
        f.width > 0 &&
        f.height > 0,
    )
    .map((f) => ({
      formatId: f.format_id,
      width: f.width,
      height: f.height,
      fps: f.fps ?? null,
      vcodec: f.vcodec ?? null,
      tbr: f.tbr ?? null,
    }));

  const quality = summarizeAvailableQuality(formats);
  if (!quality) {
    throw new InspectSourceError(
      "VIDEO_UNAVAILABLE",
      "No downloadable video streams were found for this Source Video.",
      422,
    );
  }

  const clampedInitialStart =
    normalized.initialStartSeconds !== null &&
    normalized.initialStartSeconds < durationSeconds
      ? normalized.initialStartSeconds
      : null;

  return {
    sourceVideo: {
      videoId: normalized.videoId,
      canonicalUrl: normalized.canonicalUrl,
      title: (info.title ?? normalized.videoId).trim(),
      uploader: info.uploader ?? info.channel ?? null,
      durationSeconds,
      thumbnailUrl: info.thumbnail ?? null,
      initialStartSeconds: clampedInitialStart,
      strippedPlaylist: normalized.strippedPlaylist,
      maxShortEdge: quality.maxShortEdge,
      availableQualityCaps: quality.availableQualityCaps,
      below720pWarning: quality.below720pWarning,
      isVertical: quality.isVertical,
    },
    formats,
  };
}
