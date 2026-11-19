const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

export type NormalizeYouTubeUrlResult =
  | {
      ok: true;
      videoId: string;
      canonicalUrl: string;
      initialStartSeconds: number | null;
      strippedPlaylist: boolean;
    }
  | {
      ok: false;
      code: "INVALID_URL" | "PLAYLIST_UNSUPPORTED";
      message: string;
    };

export function parseYouTubeTimeParam(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  if (/^\d+s?$/.test(trimmed)) {
    const secs = Number.parseInt(trimmed.replace(/s$/, ""), 10);
    return Number.isFinite(secs) && secs >= 0 ? secs : null;
  }

  const hmsMatch = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(trimmed);
  if (!hmsMatch) return null;

  const hours = hmsMatch[1] ? Number.parseInt(hmsMatch[1], 10) : 0;
  const minutes = hmsMatch[2] ? Number.parseInt(hmsMatch[2], 10) : 0;
  const seconds = hmsMatch[3] ? Number.parseInt(hmsMatch[3], 10) : 0;

  if (!hmsMatch[1] && !hmsMatch[2] && !hmsMatch[3]) return null;
  const total = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) && total >= 0 ? total : null;
}

export function normalizeYouTubeUrl(rawInput: string): NormalizeYouTubeUrlResult {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return {
      ok: false,
      code: "INVALID_URL",
      message: "Please enter a YouTube URL.",
    };
  }

  let parsed: URL;
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    parsed = new URL(withProtocol);
  } catch {
    return {
      ok: false,
      code: "INVALID_URL",
      message: "That does not look like a valid URL.",
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) {
    return {
      ok: false,
      code: "INVALID_URL",
      message: "Only YouTube URLs (youtube.com or youtu.be) are supported.",
    };
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  const hasListParam = parsed.searchParams.has("list");

  if (segments[0] === "playlist") {
    return {
      ok: false,
      code: "PLAYLIST_UNSUPPORTED",
      message: "Playlist URLs are not supported. Paste a link to a single YouTube video instead.",
    };
  }

  let videoId: string | null = null;
  if (host === "youtu.be" || host === "www.youtu.be") {
    videoId = segments[0] ?? null;
  } else if (segments[0] === "watch") {
    videoId = parsed.searchParams.get("v");
  } else if (
    segments[0] === "shorts" ||
    segments[0] === "live" ||
    segments[0] === "embed"
  ) {
    videoId = segments[1] ?? null;
  }

  if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) {
    if (hasListParam) {
      return {
        ok: false,
        code: "PLAYLIST_UNSUPPORTED",
        message: "Playlist URLs are not supported. Paste a link to a single YouTube video instead.",
      };
    }
    return {
      ok: false,
      code: "INVALID_URL",
      message: "Could not find a valid YouTube video ID in that URL.",
    };
  }

  const initialStartSeconds =
    parseYouTubeTimeParam(parsed.searchParams.get("t")) ??
    parseYouTubeTimeParam(parsed.searchParams.get("start"));

  return {
    ok: true,
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    initialStartSeconds,
    strippedPlaylist: hasListParam,
  };
}
