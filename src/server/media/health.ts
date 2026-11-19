import type { BinaryStatus, HealthResponse } from "../../shared/index.js";
import { runCommand } from "./process.js";

async function probeBinary(
  command: string,
  args: readonly string[],
): Promise<BinaryStatus> {
  try {
    const { stdout } = await runCommand(command, args);
    const firstLine = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    return {
      available: true,
      version: firstLine?.trim() ?? "available",
      error: null,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : `Unable to execute ${command}`;
    return {
      available: false,
      version: null,
      error: message,
    };
  }
}

export async function checkBinaryHealth(): Promise<HealthResponse> {
  const [ytDlp, ffmpeg, ffprobe] = await Promise.all([
    probeBinary("yt-dlp", ["--version"]),
    probeBinary("ffmpeg", ["-version"]),
    probeBinary("ffprobe", ["-version"]),
  ]);

  return {
    ok: ytDlp.available && ffmpeg.available && ffprobe.available,
    ytDlp,
    ffmpeg,
    ffprobe,
  };
}
