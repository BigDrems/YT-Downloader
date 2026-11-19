import { z } from "zod";

export const QualityCapSchema = z.union([z.literal(720), z.literal(1080)]);
export type QualityCap = z.infer<typeof QualityCapSchema>;

export const BinaryStatusSchema = z.object({
  available: z.boolean(),
  version: z.string().nullable(),
  error: z.string().nullable().optional(),
});
export type BinaryStatus = z.infer<typeof BinaryStatusSchema>;

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  ytDlp: BinaryStatusSchema,
  ffmpeg: BinaryStatusSchema,
  ffprobe: BinaryStatusSchema,
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const InspectRequestSchema = z.object({
  url: z.string().trim().min(1, "Please enter a YouTube URL."),
});
export type InspectRequest = z.infer<typeof InspectRequestSchema>;

export const SourceVideoSchema = z.object({
  videoId: z.string(),
  canonicalUrl: z.string().url(),
  title: z.string(),
  uploader: z.string().nullable(),
  durationSeconds: z.number().int().positive(),
  thumbnailUrl: z.string().nullable(),
  initialStartSeconds: z.number().int().nonnegative().nullable(),
  strippedPlaylist: z.boolean(),
  maxShortEdge: z.number().int().positive(),
  availableQualityCaps: z.array(QualityCapSchema),
  below720pWarning: z.boolean(),
  isVertical: z.boolean(),
});
export type SourceVideo = z.infer<typeof SourceVideoSchema>;

export const ResolvedTimeRangeSchema = z.object({
  startSeconds: z.number().int().nonnegative(),
  endSeconds: z.number().int().positive(),
  clipDurationSeconds: z.number().int().positive(),
});
export type ResolvedTimeRange = z.infer<typeof ResolvedTimeRangeSchema>;

export const CreateClipJobRequestSchema = z.object({
  url: z.string().trim().min(1, "Please enter a YouTube URL."),
  startSeconds: z.number().int().nonnegative().optional(),
  endSeconds: z.number().int().nonnegative().optional(),
  qualityCap: QualityCapSchema.default(1080),
  filename: z.string().trim().optional(),
});
export type CreateClipJobRequest = z.infer<typeof CreateClipJobRequestSchema>;

export const CreateClipJobResponseSchema = z.object({
  jobId: z.string(),
  filename: z.string(),
  resolvedTimeRange: ResolvedTimeRangeSchema,
  effectiveQuality: z.number().int().positive(),
  notices: z.array(z.string()),
});
export type CreateClipJobResponse = z.infer<typeof CreateClipJobResponseSchema>;

export const ClipJobStateSchema = z.enum([
  "downloading",
  "encoding",
  "ready",
  "cancelled",
  "failed",
]);
export type ClipJobState = z.infer<typeof ClipJobStateSchema>;

export const ClipJobEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    jobId: z.string(),
    state: z.enum(["downloading", "encoding"]),
    percent: z.number().min(0).max(100),
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal("ready"),
    jobId: z.string(),
    filename: z.string(),
    effectiveQuality: z.number().int().positive(),
    downloadUrl: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    notices: z.array(z.string()),
  }),
  z.object({
    type: z.literal("cancelled"),
    jobId: z.string(),
  }),
  z.object({
    type: z.literal("failed"),
    jobId: z.string(),
    code: z.string(),
    message: z.string(),
  }),
]);
export type ClipJobEvent = z.infer<typeof ClipJobEventSchema>;
