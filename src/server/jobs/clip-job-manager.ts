import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildDefaultClipFilename,
  normalizeYouTubeUrl,
  resolveTimeRange,
  sanitizeClipFilename,
  selectVideoStreamForQualityCap,
  type ClipJobEvent,
  type ClipJobState,
  type CreateClipJobRequest,
  type CreateClipJobResponse,
  type SourceVideo,
} from "../../shared/index.js";
import {
  InspectSourceError,
  MediaPipelineError,
  ProcessAbortedError,
  type InspectedSourceVideo,
  type MediaRunner,
} from "../media/index.js";

export const DEFAULT_CLIP_TTL_MS = 30 * 60 * 1000;
const INSPECT_CACHE_TTL_MS = 5 * 60 * 1000;

export class JobConflictError extends Error {
  readonly code = "JOB_IN_PROGRESS";
  constructor() {
    super(
      "Another Clip Job is already running. Cancel it or wait for it to finish before starting a new one.",
    );
    this.name = "JobConflictError";
  }
}

export class JobValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "JobValidationError";
    this.code = code;
  }
}

interface ClipJobRecord {
  jobId: string;
  state: ClipJobState;
  workDir: string;
  outputPath: string;
  filename: string;
  effectiveQuality: number;
  sizeBytes: number;
  notices: string[];
  abortController: AbortController;
  lastEvent: ClipJobEvent;
  listeners: Set<(event: ClipJobEvent) => void>;
  expiryTimer: NodeJS.Timeout | null;
  cleanedUp: boolean;
  finishedPromise: Promise<void>;
}

interface CachedInspection {
  inspected: InspectedSourceVideo;
  expiresAt: number;
}

export interface ClipJobManagerOptions {
  mediaRunner: MediaRunner;
  tempRootDir?: string;
  clipTtlMs?: number;
}

export interface ReadyClipInfo {
  filePath: string;
  filename: string;
  sizeBytes: number;
}

export class ClipJobManager {
  private readonly mediaRunner: MediaRunner;
  private readonly tempRootDir: string;
  private readonly clipTtlMs: number;
  private readonly jobs = new Map<string, ClipJobRecord>();
  private readonly inspectCache = new Map<string, CachedInspection>();
  private activeJobId: string | null = null;
  private startingJob = false;

  constructor(options: ClipJobManagerOptions) {
    this.mediaRunner = options.mediaRunner;
    this.tempRootDir =
      options.tempRootDir ?? path.join(os.tmpdir(), "yt-clipper");
    this.clipTtlMs = options.clipTtlMs ?? DEFAULT_CLIP_TTL_MS;
  }

  async initialize(): Promise<void> {
    await rm(this.tempRootDir, { recursive: true, force: true });
    await mkdir(this.tempRootDir, { recursive: true });
  }

  async shutdown(): Promise<void> {
    const active = this.activeJobId ? this.jobs.get(this.activeJobId) : null;
    if (active) {
      active.abortController.abort();
      await active.finishedPromise.catch(() => {});
    }

    for (const job of this.jobs.values()) {
      if (job.expiryTimer) {
        clearTimeout(job.expiryTimer);
        job.expiryTimer = null;
      }
      job.listeners.clear();
    }

    this.jobs.clear();
    this.activeJobId = null;
    await rm(this.tempRootDir, { recursive: true, force: true });
  }

  async inspect(rawUrl: string): Promise<SourceVideo> {
    const inspected = await this.mediaRunner.inspect(rawUrl);
    this.inspectCache.set(inspected.sourceVideo.videoId, {
      inspected,
      expiresAt: Date.now() + INSPECT_CACHE_TTL_MS,
    });
    return inspected.sourceVideo;
  }

  private async getOrInspect(rawUrl: string): Promise<InspectedSourceVideo> {
    const normalized = normalizeYouTubeUrl(rawUrl);
    if (!normalized.ok) {
      throw new InspectSourceError(normalized.code, normalized.message, 400);
    }

    const cached = this.inspectCache.get(normalized.videoId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.inspected;
    }

    const fresh = await this.mediaRunner.inspect(normalized.canonicalUrl);
    this.inspectCache.set(fresh.sourceVideo.videoId, {
      inspected: fresh,
      expiresAt: Date.now() + INSPECT_CACHE_TTL_MS,
    });
    return fresh;
  }

  private isBusy(): boolean {
    if (this.startingJob) return true;
    if (!this.activeJobId) return false;
    const active = this.jobs.get(this.activeJobId);
    return (
      active !== undefined &&
      (active.state === "downloading" || active.state === "encoding")
    );
  }

  async startJob(request: CreateClipJobRequest): Promise<CreateClipJobResponse> {
    if (this.isBusy()) {
      throw new JobConflictError();
    }

    this.startingJob = true;
    try {
      const inspected = await this.getOrInspect(request.url);
      const { sourceVideo, formats } = inspected;

      const timeRangeResult = resolveTimeRange({
        startSeconds: request.startSeconds,
        endSeconds: request.endSeconds,
        durationSeconds: sourceVideo.durationSeconds,
      });
      if (!timeRangeResult.ok) {
        throw new JobValidationError(
          timeRangeResult.code,
          timeRangeResult.message,
        );
      }

      const selectedStream = selectVideoStreamForQualityCap(
        formats,
        request.qualityCap,
      );
      if (!selectedStream) {
        throw new InspectSourceError(
          "VIDEO_UNAVAILABLE",
          "No downloadable video streams were found for this Source Video.",
          422,
        );
      }

      const notices = [...timeRangeResult.notices];
      if (selectedStream.below720pWarning) {
        notices.push(
          `Source Video max quality is ${selectedStream.shortEdge}p (below 720p); clipping at ${selectedStream.shortEdge}p.`,
        );
      }

      const filename = request.filename
        ? sanitizeClipFilename(request.filename)
        : buildDefaultClipFilename({
            title: sourceVideo.title,
            startSeconds: timeRangeResult.timeRange.startSeconds,
            endSeconds: timeRangeResult.timeRange.endSeconds,
            effectiveQuality: selectedStream.shortEdge,
          });

      await this.cleanupPreviousCompletedJobs();

      const jobId = randomUUID();
      const workDir = path.join(this.tempRootDir, jobId);
      await mkdir(workDir, { recursive: true });
      const outputPath = path.join(workDir, filename);

      const initialEvent: ClipJobEvent = {
        type: "progress",
        jobId,
        state: "downloading",
        percent: 0,
        detail: "Starting download...",
      };

      const abortController = new AbortController();
      let resolveFinished!: () => void;
      const finishedPromise = new Promise<void>((resolve) => {
        resolveFinished = resolve;
      });

      const job: ClipJobRecord = {
        jobId,
        state: "downloading",
        workDir,
        outputPath,
        filename,
        effectiveQuality: selectedStream.shortEdge,
        sizeBytes: 0,
        notices,
        abortController,
        lastEvent: initialEvent,
        listeners: new Set(),
        expiryTimer: null,
        cleanedUp: false,
        finishedPromise,
      };

      this.jobs.set(jobId, job);
      this.activeJobId = jobId;

      void this.executeJob(job, {
        canonicalUrl: sourceVideo.canonicalUrl,
        durationSeconds: sourceVideo.durationSeconds,
        formatId: selectedStream.formatId,
        startSeconds: timeRangeResult.timeRange.startSeconds,
        endSeconds: timeRangeResult.timeRange.endSeconds,
      }).finally(resolveFinished);

      return {
        jobId,
        filename,
        resolvedTimeRange: timeRangeResult.timeRange,
        effectiveQuality: selectedStream.shortEdge,
        notices: [...notices],
      };
    } finally {
      this.startingJob = false;
    }
  }

  private async executeJob(
    job: ClipJobRecord,
    params: {
      canonicalUrl: string;
      durationSeconds: number;
      formatId: string;
      startSeconds: number;
      endSeconds: number;
    },
  ): Promise<void> {
    try {
      const { sizeBytes } = await this.mediaRunner.produceClip({
        canonicalUrl: params.canonicalUrl,
        durationSeconds: params.durationSeconds,
        formatId: params.formatId,
        startSeconds: params.startSeconds,
        endSeconds: params.endSeconds,
        workDir: job.workDir,
        outputPath: job.outputPath,
        signal: job.abortController.signal,
        onProgress: ({ state, percent, detail }) => {
          if (job.state === "cancelled" || job.state === "failed") return;
          job.state = state;
          this.emit(job, {
            type: "progress",
            jobId: job.jobId,
            state,
            percent,
            detail,
          });
        },
        onNotice: (notice) => {
          if (!job.notices.includes(notice)) {
            job.notices.push(notice);
          }
        },
      });

      if (job.abortController.signal.aborted) {
        await this.markCancelledAndCleanup(job);
        return;
      }

      job.state = "ready";
      job.sizeBytes = sizeBytes;
      if (this.activeJobId === job.jobId) {
        this.activeJobId = null;
      }

      this.scheduleExpiry(job);
      this.emit(job, {
        type: "ready",
        jobId: job.jobId,
        filename: job.filename,
        effectiveQuality: job.effectiveQuality,
        downloadUrl: `/api/clips/${job.jobId}`,
        sizeBytes,
        notices: [...job.notices],
      });
    } catch (err) {
      if (job.abortController.signal.aborted || err instanceof ProcessAbortedError) {
        await this.markCancelledAndCleanup(job);
        return;
      }

      const code =
        err instanceof MediaPipelineError || err instanceof InspectSourceError
          ? err.code
          : "CLIP_JOB_FAILED";
      const message =
        err instanceof Error ? err.message : "Failed to create Clip.";

      job.state = "failed";
      if (this.activeJobId === job.jobId) {
        this.activeJobId = null;
      }

      await this.cleanupJobFiles(job);
      this.emit(job, {
        type: "failed",
        jobId: job.jobId,
        code,
        message,
      });
    }
  }

  private emit(job: ClipJobRecord, event: ClipJobEvent): void {
    job.lastEvent = event;
    for (const listener of job.listeners) {
      listener(event);
    }
  }

  private async markCancelledAndCleanup(job: ClipJobRecord): Promise<void> {
    const alreadyCancelled = job.state === "cancelled";
    job.state = "cancelled";
    if (this.activeJobId === job.jobId) {
      this.activeJobId = null;
    }
    await this.cleanupJobFiles(job);
    if (!alreadyCancelled) {
      this.emit(job, {
        type: "cancelled",
        jobId: job.jobId,
      });
    }
  }

  private scheduleExpiry(job: ClipJobRecord): void {
    if (job.expiryTimer) {
      clearTimeout(job.expiryTimer);
    }
    job.expiryTimer = setTimeout(() => {
      void this.cleanupJobFiles(job).then(() => {
        this.jobs.delete(job.jobId);
      });
    }, this.clipTtlMs);
    job.expiryTimer.unref();
  }

  private async cleanupJobFiles(job: ClipJobRecord): Promise<void> {
    if (job.expiryTimer) {
      clearTimeout(job.expiryTimer);
      job.expiryTimer = null;
    }
    if (job.cleanedUp) return;
    job.cleanedUp = true;
    await rm(job.workDir, { recursive: true, force: true }).catch(() => {});
  }

  private async cleanupPreviousCompletedJobs(): Promise<void> {
    const removals: Promise<void>[] = [];
    for (const [id, job] of this.jobs.entries()) {
      if (job.state !== "downloading" && job.state !== "encoding") {
        removals.push(
          this.cleanupJobFiles(job).then(() => {
            this.jobs.delete(id);
          }),
        );
      }
    }
    await Promise.all(removals);
  }

  getLastEvent(jobId: string): ClipJobEvent | null {
    return this.jobs.get(jobId)?.lastEvent ?? null;
  }

  subscribe(
    jobId: string,
    listener: (event: ClipJobEvent) => void,
  ): (() => void) | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    job.listeners.add(listener);
    return () => {
      job.listeners.delete(listener);
    };
  }

  async cancelOrDelete(
    jobId: string,
  ): Promise<"cancelled" | "deleted" | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    if (job.state === "downloading" || job.state === "encoding") {
      job.abortController.abort();
      await job.finishedPromise;
      return "cancelled";
    }

    await this.cleanupJobFiles(job);
    this.jobs.delete(jobId);
    return "deleted";
  }

  getReadyClip(jobId: string): ReadyClipInfo | null {
    const job = this.jobs.get(jobId);
    if (!job || job.state !== "ready" || job.cleanedUp) {
      return null;
    }
    return {
      filePath: job.outputPath,
      filename: job.filename,
      sizeBytes: job.sizeBytes,
    };
  }
}
