import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  XCircle,
} from "lucide-react";
import type { ClipJobEvent } from "../../shared/index.js";

export interface ActiveJobUiState {
  jobId: string;
  filename: string;
  event: ClipJobEvent;
  notices: string[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(2)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

interface ClipJobPanelProps {
  job: ActiveJobUiState;
  cancelling: boolean;
  onCancel: () => void;
}

export function ClipJobPanel({ job, cancelling, onCancel }: ClipJobPanelProps) {
  const { event } = job;
  const notices =
    event.type === "ready" ? event.notices : job.notices;

  return (
    <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
      {event.type === "progress" && (
        <>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
              <div>
                <p className="text-sm font-semibold text-zinc-100">
                  {event.state === "downloading"
                    ? "Downloading Source Video segment"
                    : "Encoding frame-accurate MP4"}
                </p>
                {event.detail && (
                  <p className="text-xs text-zinc-400">{event.detail}</p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <span className="font-mono text-sm font-semibold text-indigo-300">
                {Math.round(event.percent)}%
              </span>
              <button
                type="button"
                disabled={cancelling}
                onClick={onCancel}
                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 transition hover:bg-rose-500/20 disabled:opacity-50"
              >
                <XCircle className="h-3.5 w-3.5" />
                {cancelling ? "Cancelling..." : "Cancel"}
              </button>
            </div>
          </div>

          <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all duration-200"
              style={{ width: `${Math.max(2, Math.min(100, event.percent))}%` }}
            />
          </div>
        </>
      )}

      {event.type === "ready" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
              <div>
                <p className="text-sm font-semibold text-emerald-200">
                  Clip ready to download
                </p>
                <p className="mt-0.5 break-all font-mono text-xs text-zinc-300">
                  {event.filename}
                </p>
                <p className="mt-0.5 text-xs text-zinc-400">
                  {event.effectiveQuality}p H.264 + AAC MP4 ·{" "}
                  {formatBytes(event.sizeBytes)}
                </p>
              </div>
            </div>

            <a
              href={event.downloadUrl}
              download={event.filename}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400"
            >
              <Download className="h-4 w-4" />
              Download MP4
            </a>
          </div>

          <p className="text-[11px] text-zinc-500">
            Temporary Clips are cleaned up automatically when you start a new Clip
            Job or after 30 minutes of inactivity.
          </p>
        </div>
      )}

      {event.type === "cancelled" && (
        <div className="flex items-center gap-2.5 text-sm text-zinc-300">
          <XCircle className="h-4 w-4 text-zinc-400" />
          <span>Clip Job cancelled and temporary files removed.</span>
        </div>
      )}

      {event.type === "failed" && (
        <div className="flex items-start gap-2.5 text-sm text-rose-300" role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
          <div>
            <p className="font-semibold">Clip Job failed</p>
            <p className="mt-0.5 text-xs text-rose-200/90">{event.message}</p>
          </div>
        </div>
      )}

      {notices.length > 0 && (
        <div className="space-y-1 rounded-lg border border-amber-500/25 bg-amber-500/10 p-2.5 text-xs text-amber-200">
          {notices.map((notice) => (
            <div key={notice} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span>{notice}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
