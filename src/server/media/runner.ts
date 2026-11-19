import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { formatTimestamp } from "../../shared/index.js";
import { encodeClipWithFfmpeg } from "./encoder.js";
import {
  classifyYtDlpStderr,
  inspectSourceVideo,
  type InspectedSourceVideo,
} from "./inspector.js";
import { ProcessExitError, runCommand } from "./process.js";

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

export function parseFfmpegTimeProgress(
  line: string,
  expectedDurationSeconds: number,
): { percent: number; currentSeconds: number } | null {
  if (!Number.isFinite(expectedDurationSeconds) || expectedDurationSeconds <= 0) {
    return null;
  }

  if (line.startsWith("out_time_us=")) {
    const rawUs = Number.parseInt(line.slice("out_time_us=".length), 10);
    if (!Number.isFinite(rawUs) || rawUs < 0) return null;
    const currentSeconds = rawUs / 1_000_000;
    const percent = Math.max(
      0,
      Math.min(99, (currentSeconds / expectedDurationSeconds) * 100),
    );
    return { percent, currentSeconds };
  }

  const timeMatch = /\btime=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
  if (!timeMatch) return null;

  const hours = Number.parseInt(timeMatch[1]!, 10);
  const minutes = Number.parseInt(timeMatch[2]!, 10);
  const seconds = Number.parseFloat(timeMatch[3]!);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }

  const currentSeconds = hours * 3600 + minutes * 60 + seconds;
  if (currentSeconds < 0) return null;

  const percent = Math.max(
    0,
    Math.min(99, (currentSeconds / expectedDurationSeconds) * 100),
  );
  return { percent, currentSeconds };
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

    const formatSelector = `${params.formatId}+bestaudio/best[height<=1080]`;
    const outputTemplate = path.join(params.workDir, "source.%(ext)s");

    let usedFullDownload = !isPartial;

    const runYtDlp = async (useSection: boolean) => {
      const args = [
        "--no-playlist",
        "--progress",
        "--newline",
        "--progress-delta",
        "0.25",
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
          `*${params.startSeconds}-${params.endSeconds}`,
          "--force-keyframes-at-cuts",
          "--downloader-args",
          "ffmpeg_o:-stats -stats_period 0.25",
        );
      }

      args.push(params.canonicalUrl);

      let lastPct = -1;
      let destinationCount = 0;

      const emitDownloadProgress = (percent: number, detail: string) => {
        const rounded = Math.max(0, Math.min(99, Math.round(percent)));
        if (rounded > lastPct) {
          lastPct = rounded;
          params.onProgress({
            state: "downloading",
            percent: rounded,
            detail,
          });
        }
      };

      params.onProgress({
        state: "downloading",
        percent: 0,
        detail: useSection
          ? "Downloading requested segment..."
          : "Downloading video stream...",
      });

      const handleLine = (line: string) => {
        if (line.includes("[download] Destination:")) {
          destinationCount += 1;
          return;
        }

        if (line.includes("[Merger]")) {
          emitDownloadProgress(98, "Merging video and audio...");
          return;
        }

        const ytPct = parseYtDlpProgressLine(line);
        if (ytPct !== null) {
          if (useSection) {
            emitDownloadProgress(ytPct * 0.96, "Downloading requested segment...");
          } else if (destinationCount <= 1) {
            emitDownloadProgress(ytPct * 0.8, "Downloading video stream...");
          } else {
            emitDownloadProgress(80 + ytPct * 0.16, "Downloading audio stream...");
          }
          return;
        }

        const expectedDuration = useSection ? clipDuration : params.durationSeconds;
        const ffmpegProg = parseFfmpegTimeProgress(line, expectedDuration);
        if (ffmpegProg !== null) {
          emitDownloadProgress(
            ffmpegProg.percent,
            `Downloading segment (${formatTimestamp(ffmpegProg.currentSeconds)} / ${formatTimestamp(expectedDuration)})...`,
          );
        }
      };

      await runCommand("yt-dlp", args, {
        signal: params.signal,
        onStdoutLine: handleLine,
        onStderrLine: handleLine,
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
    const trimStartSeconds = usedFullDownload ? params.startSeconds : 0;

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
