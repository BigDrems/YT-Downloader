import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { HealthResponse } from "../shared/index.js";
import { createApp } from "./app.js";
import { ClipJobManager } from "./jobs/clip-job-manager.js";
import { checkBinaryHealth, LocalMediaRunner } from "./media/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDistDir = path.resolve(__dirname, "../../client");

async function main() {
  const mediaRunner = new LocalMediaRunner();
  const jobManager = new ClipJobManager({ mediaRunner });
  await jobManager.initialize();

  let cachedHealthPromise: Promise<HealthResponse> | null = null;
  const getHealth = (options?: { refresh?: boolean }): Promise<HealthResponse> => {
    if (options?.refresh || !cachedHealthPromise) {
      cachedHealthPromise = checkBinaryHealth();
    }
    return cachedHealthPromise;
  };

  // Warm health check in the background so the HTTP server starts immediately.
  void getHealth().then((health) => {
    if (!health.ok) {
      console.warn(
        "Warning: One or more required binaries are unavailable:",
        health,
      );
    } else {
      console.log(
        `Dependencies OK — yt-dlp: ${health.ytDlp.version}, ffmpeg ready`,
      );
    }
  });

  const app = createApp({
    jobManager,
    checkHealth: getHealth,
    clientDistDir,
  });

  const port = Number(process.env.PORT ?? 3001);
  const server = serve(
    {
      fetch: app.fetch,
      port,
      hostname: "127.0.0.1",
    },
    (info) => {
      console.log(`YT Clipper listening on http://${info.address}:${info.port}`);
    },
  );

  const handleShutdown = async (signalName: string) => {
    console.log(`Received ${signalName}, cleaning up temporary files...`);
    server.close();
    await jobManager.shutdown();
    process.exit(0);
  };

  process.once("SIGINT", () => void handleShutdown("SIGINT"));
  process.once("SIGTERM", () => void handleShutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Failed to start YT Clipper server:", err);
  process.exit(1);
});
