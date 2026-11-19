import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { encodeClipWithFfmpeg, probeMediaTiming } from "./encoder.js";
import {
  classifyYtDlpStderr,
  inspectSourceVideo,
  type InspectedSourceVideo,
} from "./inspector.js";
import { ProcessExitError, runCommand } from "./process.js";

export const SECTION_PADDING_SECONDS = 10;
export const MAX_FULL_FALLBACK_DURATION_SECONDS = 15 * 60;

export interface RunClipMediaParams {
  canonicalUrl: string;
  durationSeconds: number;
  formatId: string;
  startSeconds: number;
  endSeconds: number;
  workDir: string;
  outputPath: string;
  signal: AbortSignal;
  onProgress: (update: {
    state: "downloading" | "encoding";
    percent: number;
    detail?: string;
  }) => void;
  onNotice: (notice: string) => void;
}

export interface MediaRunner {
  inspect(rawUrl: string, signal?: AbortSignal): Promise<InspectedSourceVideo>;
  produceClip(params: RunClipMediaParams): Promise<{ sizeBytes: number }>;
}

export class MediaPipelineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MediaPipelineError";
    this.code = code;
  }
}

export function parseYtDlpProgressLine(line: string): number | null {
  const match = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
  if (!match?.[1]) return null;
  const pct = Number.parseFloat(match[1]);
  return Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
}

async function findDownloadedSourceFile(workDir: string): Promise<string> {
  const entries = await readdir(workDir);
  const candidate = entries.find(
    (name) =>
      name.startsWith("source.") &&
      !name.endsWith(".part") &&
      !name.endsWith(".ytdl"),
  );
  if (!candidate) {
    throw new MediaPipelineError(
      "DOWNLOAD_MISSING",
      "yt-dlp completed without producing a media file.",
    );
  }
  return path.join(workDir, candidate);
}

async function clearDownloadedSourceFiles(workDir: string): Promise<void> {
  const entries = await readdir(workDir).catch(() => []);
  await Promise.all(
    entries
      .filter((name) => name.startsWith("source."))
      .map((name) => rm(path.join(workDir, name), { force: true })),
  );
}

export class LocalMediaRunner implements MediaRunner {
  inspect(rawUrl: string, signal?: AbortSignal): Promise<InspectedSourceVideo> {
    return inspectSourceVideo(rawUrl, signal);
  }

  async produceClip(params: RunClipMediaParams): Promise<{ sizeBytes: number }> {
    const clipDuration = params.endSeconds - params.startSeconds;
    const isPartial =
      params.startSeconds > 0 || params.endSeconds < params.durationSeconds;

    const padStart = isPartial
      ? Math.max(0, params.startSeconds - SECTION_PADDING_SECONDS)
      : 0;
    const padEnd = isPartial
      ? Math.min(params.durationSeconds, params.endSeconds + SECTION_PADDING_SECONDS)
      : params.durationSeconds;

    const formatSelector = `${params.formatId}+bestaudio/best[height<=1080]`;
    const outputTemplate = path.join(params.workDir, "source.%(ext)s");

    let usedFullDownload = !isPartial;

    const runYtDlp = async (useSection: boolean) => {
      const args = [
        "--no-playlist",
        "--newline",
        "--no-warnings",
        "-f",
        formatSelector,
        "--merge-output-format",
        "mkv",
        "-o",
        outputTemplate,
      ];

      if (useSection) {
        args.push(
          "--download-sections",
          `*${padStart}-${padEnd}`,
          "--downloader-args",
          "ffmpeg_o:-copyts",
          "--postprocessor-args",
          "Merger:-copyts -avoid_negative_ts disabled",
        );
      }

      args.push(params.canonicalUrl);

      let lastPct = -1;
      params.onProgress({
        state: "downloading",
        percent: 0,
        detail: useSection ? "Downloading requested segment..." : "Downloading video...",
      });

      await runCommand("yt-dlp", args, {
        signal: params.signal,
        onStdoutLine: (line) => {
          const pct = parseYtDlpProgressLine(line);
          if (pct !== null) {
            const rounded = Math.round(pct);
            if (rounded !== lastPct) {
              lastPct = rounded;
              params.onProgress({
                state: "downloading",
                percent: rounded,
                detail: useSection
                  ? "Downloading requested segment..."
                  : "Downloading video...",
              });
            }
          }
        },
      });

      params.onProgress({
        state: "downloading",
        percent: 100,
        detail: "Download complete.",
      });
    };

    if (isPartial) {
      try {
        await runYtDlp(true);
      } catch (err) {
        if (params.signal.aborted) {
          throw err;
        }
        if (params.durationSeconds <= MAX_FULL_FALLBACK_DURATION_SECONDS) {
          params.onNotice(
            "Section download failed on this stream; fell back to full download (video is 15 minutes or shorter).",
          );
          await clearDownloadedSourceFiles(params.workDir);
          usedFullDownload = true;
          try {
            await runYtDlp(false);
          } catch (fallbackErr) {
            if (fallbackErr instanceof ProcessExitError) {
              const classified = classifyYtDlpStderr(fallbackErr.stderr);
              throw new MediaPipelineError(classified.code, classified.message);
            }
            throw fallbackErr;
          }
        } else {
          throw new MediaPipelineError(
            "SECTION_DOWNLOAD_FAILED",
            "Section download failed for this video. Because it exceeds 15 minutes, YT Clipper stopped instead of downloading the entire video.",
          );
        }
      }
    } else {
      try {
        await runYtDlp(false);
      } catch (err) {
        if (err instanceof ProcessExitError) {
          const classified = classifyYtDlpStderr(err.stderr);
          throw new MediaPipelineError(classified.code, classified.message);
        }
        throw err;
      }
    }

    const downloadedPath = await findDownloadedSourceFile(params.workDir);
    const probed = await probeMediaTiming(downloadedPath, params.signal);

    let trimStartSeconds: number;
    if (usedFullDownload) {
      trimStartSeconds = params.startSeconds;
    } else if (probed.startTimeSeconds > 0.5) {
      trimStartSeconds = Math.max(0, params.startSeconds - probed.startTimeSeconds);
    } else {
      trimStartSeconds = Math.max(0, params.startSeconds - padStart);
    }

    await encodeClipWithFfmpeg({
      inputPath: downloadedPath,
      outputPath: params.outputPath,
      trimStartSeconds,
      durationSeconds: clipDuration,
      signal: params.signal,
      onProgress: (percent) => {
        params.onProgress({
          state: "encoding",
          percent,
          detail: "Encoding frame-accurate H.264 + AAC MP4...",
        });
      },
    });

    const stats = await stat(params.outputPath);
    return { sizeBytes: stats.size };
  }
}
