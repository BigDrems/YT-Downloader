import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeClipWithFfmpeg, probeClipDetails } from "./encoder.js";
import { runCommand } from "./process.js";

describe("encodeClipWithFfmpeg (offline ffmpeg smoke test)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("trims a synthetic video with frame accuracy and encodes to H.264 yuv420p + stereo AAC MP4 without chapters", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "yt-clipper-smoke-"));
    tempDirs.push(dir);

    const metadataFile = path.join(dir, "chapters.txt");
    await writeFile(
      metadataFile,
      [
        ";FFMETADATA1",
        "[CHAPTER]",
        "TIMEBASE=1/1000",
        "START=0",
        "END=3000",
        "title=Intro",
      ].join("\n"),
      "utf8",
    );

    const sourcePath = path.join(dir, "synthetic.mkv");
    const outputPath = path.join(dir, "clip.mp4");

    await runCommand("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30:duration=6",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=6",
      "-i",
      metadataFile,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-map_metadata",
      "2",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      sourcePath,
    ]);

    const progressValues: number[] = [];
    await encodeClipWithFfmpeg({
      inputPath: sourcePath,
      outputPath,
      trimStartSeconds: 1,
      durationSeconds: 3,
      onProgress: (pct) => progressValues.push(pct),
    });

    const details = await probeClipDetails(outputPath);

    expect(details.videoCodec).toBe("h264");
    expect(details.pixelFormat).toBe("yuv420p");
    expect(details.width).toBe(320);
    expect(details.height).toBe(180);
    expect(details.audioCodec).toBe("aac");
    expect(details.audioChannels).toBe(2);
    expect(details.durationSeconds).toBeGreaterThanOrEqual(2.85);
    expect(details.durationSeconds).toBeLessThanOrEqual(3.15);
    expect(details.subtitleStreamCount).toBe(0);
    expect(details.chapterCount).toBe(0);
    expect(details.sizeBytes).toBeGreaterThan(0);
    expect(progressValues[0]).toBe(0);
    expect(progressValues.at(-1)).toBe(100);
  }, 30_000);
});
