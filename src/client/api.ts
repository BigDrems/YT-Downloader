import {
  ClipJobEventSchema,
  CreateClipJobResponseSchema,
  HealthResponseSchema,
  SourceVideoSchema,
  type ClipJobEvent,
  type CreateClipJobRequest,
  type CreateClipJobResponse,
  type HealthResponse,
  type SourceVideo,
} from "../shared/index.js";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function parseError(res: Response): Promise<ApiError> {
  const payload = (await res.json().catch(() => null)) as {
    code?: string;
    message?: string;
  } | null;
  return new ApiError(
    res.status,
    payload?.code ?? "API_ERROR",
    payload?.message ?? `Request failed with HTTP ${res.status}`,
  );
}

export async function fetchHealth(refresh = false): Promise<HealthResponse> {
  const res = await fetch(refresh ? "/api/health?refresh=1" : "/api/health");
  if (!res.ok) throw await parseError(res);
  return HealthResponseSchema.parse(await res.json());
}

export async function inspectVideo(url: string): Promise<SourceVideo> {
  const res = await fetch("/api/inspect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw await parseError(res);
  return SourceVideoSchema.parse(await res.json());
}

export async function createClipJob(
  body: CreateClipJobRequest,
): Promise<CreateClipJobResponse> {
  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  return CreateClipJobResponseSchema.parse(await res.json());
}

export async function cancelOrDeleteJob(jobId: string): Promise<void> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw await parseError(res);
  }
}

export function subscribeToJobEvents(
  jobId: string,
  onEvent: (event: ClipJobEvent) => void,
  onConnectionError: () => void,
): () => void {
  const source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
  let terminalReceived = false;

  const handleMessage = (raw: MessageEvent<string>) => {
    try {
      const parsed = ClipJobEventSchema.parse(JSON.parse(raw.data));
      if (
        parsed.type === "ready" ||
        parsed.type === "cancelled" ||
        parsed.type === "failed"
      ) {
        terminalReceived = true;
        source.close();
      }
      onEvent(parsed);
    } catch {
      // Ignore malformed frame.
    }
  };

  source.addEventListener("progress", handleMessage as EventListener);
  source.addEventListener("ready", handleMessage as EventListener);
  source.addEventListener("cancelled", handleMessage as EventListener);
  source.addEventListener("failed", handleMessage as EventListener);

  source.onerror = () => {
    if (!terminalReceived) {
      source.close();
      onConnectionError();
    }
  };

  return () => {
    source.close();
  };
}
