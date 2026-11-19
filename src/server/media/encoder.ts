import { runCommand } from "./process.js";

export interface ProbedFormatInfo {
  startTimeSeconds: number;
  durationSeconds: number;
}

export interface ProbedClipDetails {
  durationSeconds: number;
  sizeBytes: number;
  videoCodec: string | null;
  pixelFormat: string | null;
  width: number | null;
  height: number | null;
  audioCodec: string | null;
  audioChannels: number | null;
  subtitleStreamCount: number;
  chapterCount: number;
}

interface RawFfprobeOutput {
  format?: {
    start_time?: string;
    duration?: string;
    size?: string;
  };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    pix_fmt?: string;
    width?: number;
    height?: number;
    channels?: number;
  }>;
  chapters?: unknown[];
}

export async function probeMediaTiming(
  filePath: string,
  signal?: AbortSignal,
): Promise<ProbedFormatInfo> {
  const { stdout } = await runCommand(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=start_time,duration",
      "-of",
      "json",
      filePath,
    ],
    { signal },
  );

  const parsed = JSON.parse(stdout) as RawFfprobeOutput;
  const startTimeSeconds = Number.parseFloat(parsed.format?.start_time ?? "0");
  const durationSeconds = Number.parseFloat(parsed.format?.duration ?? "0");

  return {
    startTimeSeconds: Number.isFinite(startTimeSeconds) ? startTimeSeconds : 0,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
  };
}

export async function probeClipDetails(
  filePath: string,
  signal?: AbortSignal,
): Promise<ProbedClipDetails> {
  const { stdout } = await runCommand(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size:stream=codec_type,codec_name,pix_fmt,width,height,channels",
      "-show_chapters",
      "-of",
      "json",
      filePath,
    ],
    { signal },
  );

  const parsed = JSON.parse(stdout) as RawFfprobeOutput;
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const subtitleStreamCount = streams.filter(
    (s) => s.codec_type === "subtitle",
  ).length;

  return {
    durationSeconds: Number.parseFloat(parsed.format?.duration ?? "0") || 0,
    sizeBytes: Number.parseInt(parsed.format?.size ?? "0", 10) || 0,
    videoCodec: video?.codec_name ?? null,
    pixelFormat: video?.pix_fmt ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    audioCodec: audio?.codec_name ?? null,
    audioChannels: audio?.channels ?? null,
    subtitleStreamCount,
    chapterCount: parsed.chapters?.length ?? 0,
  };
}

export interface EncodeClipParams {
  inputPath: string;
  outputPath: string;
  trimStartSeconds: number;
  durationSeconds: number;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}

export function buildFfmpegEncodeArgs(params: {
  inputPath: string;
  outputPath: string;
  trimStartSeconds: number;
  durationSeconds: number;
}): string[] {
  const trimStart = Math.max(0, params.trimStartSeconds);
  const args = ["-y"];

  if (trimStart > 0) {
    args.push("-ss", trimStart.toFixed(3));
  }

  args.push(
    "-i",
    params.inputPath,
    "-t",
    params.durationSeconds.toFixed(3),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-sn",
    "-dn",
    "-map_chapters",
    "-1",
    "-c:v",
    "libx264",
    "-crf",
    "20",
    "-preset",
    "fast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    "-nostats",
    params.outputPath,
  );

  return args;
}

export async function encodeClipWithFfmpeg(
  params: EncodeClipParams,
): Promise<void> {
  const expectedDurationUs = Math.max(1, params.durationSeconds * 1_000_000);
  let lastReported = -1;

  const emitPercent = (percent: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    if (clamped !== lastReported) {
      lastReported = clamped;
      params.onProgress?.(clamped);
    }
  };

  emitPercent(0);

  const args = buildFfmpegEncodeArgs(params);
  await runCommand("ffmpeg", args, {
    signal: params.signal,
    onStdoutLine: (line) => {
      if (line.startsWith("out_time_us=")) {
        const rawUs = Number.parseInt(line.slice("out_time_us=".length), 10);
        if (Number.isFinite(rawUs) && rawUs >= 0) {
          emitPercent((rawUs / expectedDurationUs) * 100);
        }
      } else if (line === "progress=end") {
        emitPercent(100);
      }
    },
  });

  emitPercent(100);
}
