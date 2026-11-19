import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  CreateClipJobRequestSchema,
  InspectRequestSchema,
  type ClipJobEvent,
  type HealthResponse,
} from "../shared/index.js";
import {
  ClipJobManager,
  JobConflictError,
  JobValidationError,
} from "./jobs/clip-job-manager.js";
import { InspectSourceError } from "./media/index.js";

export interface CreateAppOptions {
  jobManager: ClipJobManager;
  checkHealth: (options?: { refresh?: boolean }) => Promise<HealthResponse>;
  clientDistDir?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

function isTerminalEvent(event: ClipJobEvent): boolean {
  return (
    event.type === "ready" ||
    event.type === "cancelled" ||
    event.type === "failed"
  );
}

function encodeContentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  const utf8Encoded = encodeURIComponent(filename);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
}

export function createApp(options: CreateAppOptions): Hono {
  const app = new Hono();
  const { jobManager, checkHealth, clientDistDir } = options;

  app.get("/api/health", async (c) => {
    const refresh = c.req.query("refresh") === "1";
    const health = await checkHealth({ refresh });
    return c.json(health, 200);
  });

  app.post("/api/inspect", async (c) => {
    const rawBody = await c.req.json().catch(() => null);
    const parsed = InspectRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_REQUEST",
          message: parsed.error.issues[0]?.message ?? "Invalid request body.",
        },
        400,
      );
    }

    try {
      const sourceVideo = await jobManager.inspect(parsed.data.url);
      return c.json(sourceVideo, 200);
    } catch (err) {
      if (err instanceof InspectSourceError) {
        return c.json({ code: err.code, message: err.message }, err.httpStatus);
      }
      const message =
        err instanceof Error ? err.message : "Failed to inspect Source Video.";
      return c.json({ code: "INSPECT_FAILED", message }, 502);
    }
  });

  app.post("/api/jobs", async (c) => {
    const rawBody = await c.req.json().catch(() => null);
    const parsed = CreateClipJobRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_REQUEST",
          message: parsed.error.issues[0]?.message ?? "Invalid Clip Job request.",
        },
        400,
      );
    }

    try {
      const created = await jobManager.startJob(parsed.data);
      return c.json(created, 201);
    } catch (err) {
      if (err instanceof JobConflictError) {
        return c.json({ code: err.code, message: err.message }, 409);
      }
      if (err instanceof JobValidationError) {
        return c.json({ code: err.code, message: err.message }, 400);
      }
      if (err instanceof InspectSourceError) {
        return c.json({ code: err.code, message: err.message }, err.httpStatus);
      }
      const message =
        err instanceof Error ? err.message : "Failed to start Clip Job.";
      return c.json({ code: "JOB_START_FAILED", message }, 500);
    }
  });

  app.get("/api/jobs/:jobId/events", (c) => {
    const jobId = c.req.param("jobId");
    const initial = jobManager.getLastEvent(jobId);
    if (!initial) {
      return c.json(
        { code: "JOB_NOT_FOUND", message: "Clip Job not found or expired." },
        404,
      );
    }

    return streamSSE(c, async (stream) => {
      let closed = false;
      let finishStream!: () => void;
      const done = new Promise<void>((resolve) => {
        finishStream = resolve;
      });

      stream.onAbort(() => {
        closed = true;
        finishStream();
      });

      const sendEvent = async (event: ClipJobEvent) => {
        if (closed) return;
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        });
        if (isTerminalEvent(event)) {
          closed = true;
          finishStream();
        }
      };

      const unsubscribe = jobManager.subscribe(jobId, (event) => {
        void sendEvent(event);
      });

      try {
        await sendEvent(initial);
        if (!closed) {
          await done;
        }
      } finally {
        unsubscribe?.();
      }
    });
  });

  app.delete("/api/jobs/:jobId", async (c) => {
    const jobId = c.req.param("jobId");
    const status = await jobManager.cancelOrDelete(jobId);
    if (!status) {
      return c.json(
        { code: "JOB_NOT_FOUND", message: "Clip Job not found or already cleaned up." },
        404,
      );
    }
    return c.json({ status }, 200);
  });

  app.get("/api/clips/:jobId", (c) => {
    const jobId = c.req.param("jobId");
    const clip = jobManager.getReadyClip(jobId);
    if (!clip || !existsSync(clip.filePath)) {
      return c.json(
        { code: "CLIP_NOT_FOUND", message: "Clip not found or expired." },
        404,
      );
    }

    const nodeStream = createReadStream(clip.filePath);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

    return new Response(webStream, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(clip.sizeBytes),
        "Content-Disposition": encodeContentDisposition(clip.filename),
        "Cache-Control": "no-store",
      },
    });
  });

  if (clientDistDir && existsSync(clientDistDir)) {
    const resolvedRoot = path.resolve(clientDistDir);

    app.get("*", async (c) => {
      if (c.req.path.startsWith("/api/")) {
        return c.json({ code: "NOT_FOUND", message: "API route not found." }, 404);
      }

      const relPath = c.req.path === "/" ? "index.html" : c.req.path.replace(/^\/+/, "");
      const candidate = path.resolve(resolvedRoot, relPath);

      if (candidate.startsWith(resolvedRoot) && existsSync(candidate)) {
        const ext = path.extname(candidate).toLowerCase();
        const body = await readFile(candidate);
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": MIME_BY_EXT[ext] ?? "application/octet-stream",
          },
        });
      }

      const indexHtml = path.join(resolvedRoot, "index.html");
      if (existsSync(indexHtml)) {
        const body = await readFile(indexHtml);
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return c.text("Not Found", 404);
    });
  }

  return app;
}
