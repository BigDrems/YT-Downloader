import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClipJobEvent, HealthResponse } from "../shared/index.js";
import { createApp } from "./app.js";
import { ClipJobManager } from "./jobs/clip-job-manager.js";
import {
  InspectSourceError,
  ProcessAbortedError,
  type InspectedSourceVideo,
  type MediaRunner,
  type RunClipMediaParams,
} from "./media/index.js";

function makeSampleInspection(overrides?: {
  durationSeconds?: number;
  maxShortEdge?: number;
  below720pWarning?: boolean;
}): InspectedSourceVideo {
  const durationSeconds = overrides?.durationSeconds ?? 180;
  const maxShortEdge = overrides?.maxShortEdge ?? 1080;
  const below720pWarning = overrides?.below720pWarning ?? maxShortEdge < 720;

  return {
    sourceVideo: {
      videoId: "dQw4w9WgXcQ",
      canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "Sample Demo Video",
      uploader: "Demo Channel",
      durationSeconds,
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      initialStartSeconds: null,
      strippedPlaylist: false,
      maxShortEdge,
      availableQualityCaps:
        maxShortEdge >= 1080 ? [720, 1080] : maxShortEdge >= 720 ? [720] : [],
      below720pWarning,
      isVertical: false,
    },
    formats: [
      {
        formatId: "best-vid",
        width: Math.round((maxShortEdge * 16) / 9),
        height: maxShortEdge,
        fps: 60,
        vcodec: "vp9",
      },
    ],
  };
}

const healthyResponse: HealthResponse = {
  ok: true,
  ytDlp: { available: true, version: "2026.10.26", error: null },
  ffmpeg: { available: true, version: "ffmpeg 7.x", error: null },
  ffprobe: { available: true, version: "ffprobe 7.x", error: null },
};

function parseSsePayloads(rawText: string): ClipJobEvent[] {
  const events: ClipJobEvent[] = [];
  for (const chunk of rawText.split("\n\n")) {
    const dataLine = chunk
      .split("\n")
      .find((line) => line.startsWith("data:"));
    if (dataLine) {
      events.push(JSON.parse(dataLine.slice("data:".length).trim()) as ClipJobEvent);
    }
  }
  return events;
}

describe("Clip Job API & Manager", () => {
  const tempDirs: string[] = [];
  const managers: ClipJobManager[] = [];

  afterEach(async () => {
    for (const manager of managers.splice(0)) {
      await manager.shutdown();
    }
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function setup(runner: MediaRunner, clipTtlMs = 60_000) {
    const tempRootDir = await mkdtemp(path.join(os.tmpdir(), "yt-clipper-api-"));
    tempDirs.push(tempRootDir);
    const jobManager = new ClipJobManager({
      mediaRunner: runner,
      tempRootDir,
      clipTtlMs,
    });
    await jobManager.initialize();
    managers.push(jobManager);
    const app = createApp({
      jobManager,
      checkHealth: async () => healthyResponse,
    });
    return { app, jobManager, tempRootDir };
  }

  it("returns dependency health and rejects invalid or livestream URLs on /api/inspect", async () => {
    const runner: MediaRunner = {
      inspect: async (url) => {
        if (url.includes("liveStream11")) {
          throw new InspectSourceError(
            "LIVESTREAM_UNSUPPORTED",
            "Active livestreams are not supported.",
            422,
          );
        }
        return makeSampleInspection();
      },
      produceClip: async () => ({ sizeBytes: 0 }),
    };

    const { app } = await setup(runner);

    const healthRes = await app.request("/api/health");
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual(healthyResponse);

    const liveRes = await app.request("/api/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=liveStream11",
      }),
    });
    expect(liveRes.status).toBe(422);
    expect(await liveRes.json()).toMatchObject({
      code: "LIVESTREAM_UNSUPPORTED",
    });
  });

  it("runs a full Clip Job lifecycle, streams SSE events, and serves the finished MP4", async () => {
    const fakeMp4 = Buffer.from("FAKE_MP4_BYTES_12345");
    const runner: MediaRunner = {
      inspect: async () => makeSampleInspection({ durationSeconds: 120 }),
      produceClip: async (params: RunClipMediaParams) => {
        params.onProgress({ state: "downloading", percent: 50 });
        await new Promise((r) => setTimeout(r, 15));
        params.onProgress({ state: "encoding", percent: 80 });
        await writeFile(params.outputPath, fakeMp4);
        return { sizeBytes: fakeMp4.length };
      },
    };

    const { app } = await setup(runner);

    const createRes = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        startSeconds: 10,
        endSeconds: 999,
        qualityCap: 1080,
      }),
    });

    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      jobId: string;
      filename: string;
      resolvedTimeRange: { startSeconds: number; endSeconds: number };
      notices: string[];
    };
    expect(created.resolvedTimeRange).toMatchObject({
      startSeconds: 10,
      endSeconds: 120,
    });
    expect(created.notices.some((n) => /clamped/i.test(n))).toBe(true);

    const sseRes = await app.request(`/api/jobs/${created.jobId}/events`);
    expect(sseRes.status).toBe(200);
    const events = parseSsePayloads(await sseRes.text());
    const readyEvent = events.find((e) => e.type === "ready");
    expect(readyEvent).toBeDefined();
    expect(readyEvent?.type === "ready" && readyEvent.sizeBytes).toBe(
      fakeMp4.length,
    );

    const clipRes = await app.request(`/api/clips/${created.jobId}`);
    expect(clipRes.status).toBe(200);
    expect(clipRes.headers.get("content-type")).toBe("video/mp4");
    expect(clipRes.headers.get("content-disposition")).toContain(
      `attachment; filename="${created.filename}"`,
    );
    const downloaded = Buffer.from(await clipRes.arrayBuffer());
    expect(downloaded.equals(fakeMp4)).toBe(true);
  });

  it("enforces single active Clip Job (409 Conflict) and cleans up temp files on cancel", async () => {
    let capturedWorkDir = "";
    let signalAborted = false;

    const runner: MediaRunner = {
      inspect: async () => makeSampleInspection(),
      produceClip: async (params) => {
        capturedWorkDir = params.workDir;
        await writeFile(path.join(params.workDir, "partial.mkv"), "partial");
        if (params.signal.aborted) {
          signalAborted = true;
          throw new ProcessAbortedError();
        }
        return new Promise((_, reject) => {
          params.signal.addEventListener("abort", () => {
            signalAborted = true;
            reject(new ProcessAbortedError());
          });
        });
      },
    };

    const { app } = await setup(runner);

    const first = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        qualityCap: 720,
      }),
    });
    expect(first.status).toBe(201);
    const { jobId } = (await first.json()) as { jobId: string };

    const second = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        qualityCap: 1080,
      }),
    });
    expect(second.status).toBe(409);

    const cancelRes = await app.request(`/api/jobs/${jobId}`, {
      method: "DELETE",
    });
    expect(cancelRes.status).toBe(200);
    expect(await cancelRes.json()).toEqual({ status: "cancelled" });
    expect(signalAborted).toBe(true);
    expect(existsSync(capturedWorkDir)).toBe(false);
  });

  it("auto-cleans completed Clips after TTL expiration", async () => {
    let capturedWorkDir = "";
    const runner: MediaRunner = {
      inspect: async () => makeSampleInspection({ maxShortEdge: 480 }),
      produceClip: async (params) => {
        capturedWorkDir = params.workDir;
        await writeFile(params.outputPath, Buffer.from("short-lived"));
        return { sizeBytes: 11 };
      },
    };

    const { app } = await setup(runner, 40);

    const createRes = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        qualityCap: 1080,
      }),
    });
    const created = (await createRes.json()) as {
      jobId: string;
      notices: string[];
    };
    expect(created.notices.some((n) => n.includes("480p"))).toBe(true);

    // Wait for job completion
    const sseRes = await app.request(`/api/jobs/${created.jobId}/events`);
    await sseRes.text();
    expect(existsSync(capturedWorkDir)).toBe(true);

    // Wait past 40ms TTL
    await new Promise((r) => setTimeout(r, 90));
    expect(existsSync(capturedWorkDir)).toBe(false);

    const afterExpiry = await app.request(`/api/clips/${created.jobId}`);
    expect(afterExpiry.status).toBe(404);
  });
});
