import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Film,
  Loader2,
  RefreshCw,
  Scissors,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import {
  buildDefaultClipFilename,
  formatTimestamp,
  normalizeYouTubeUrl,
  parseTimestampInput,
  resolveTimeRange,
  type HealthResponse,
  type QualityCap,
  type SourceVideo,
} from "../shared/index.js";
import {
  ApiError,
  cancelOrDeleteJob,
  createClipJob,
  fetchHealth,
  inspectVideo,
  subscribeToJobEvents,
} from "./api.js";
import {
  ClipJobPanel,
  type ActiveJobUiState,
} from "./components/ClipJobPanel.js";
import { TimeRangeControls } from "./components/TimeRangeControls.js";
import { YouTubePreview } from "./components/YouTubePreview.js";

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);

  const [urlInput, setUrlInput] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [sourceVideo, setSourceVideo] = useState<SourceVideo | null>(null);

  const [startInput, setStartInput] = useState("");
  const [endInput, setEndInput] = useState("");
  const [qualityCap, setQualityCap] = useState<QualityCap>(1080);
  const [customFilename, setCustomFilename] = useState("");

  const [startingJob, setStartingJob] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [jobError, setJobError] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<ActiveJobUiState | null>(null);

  const unsubscribeRef = useRef<(() => void) | null>(null);

  const loadHealth = async (refresh = false) => {
    setHealthLoading(true);
    try {
      const data = await fetchHealth(refresh);
      setHealth(data);
    } catch {
      setHealth(null);
    } finally {
      setHealthLoading(false);
    }
  };

  useEffect(() => {
    void loadHealth();
    return () => {
      unsubscribeRef.current?.();
    };
  }, []);

  const isJobRunning =
    startingJob || (activeJob?.event.type === "progress" && !cancelling);

  const parsedRange = useMemo(() => {
    if (!sourceVideo) {
      return {
        parseError: null as string | null,
        startSeconds: undefined as number | undefined,
        endSeconds: undefined as number | undefined,
        validation: null,
      };
    }

    let startSeconds: number | undefined;
    if (startInput.trim() !== "") {
      const parsed = parseTimestampInput(startInput);
      if (parsed === null) {
        return {
          parseError:
            "Start time must be whole seconds (e.g. 90, 01:30, or 01:02:03).",
          startSeconds: undefined,
          endSeconds: undefined,
          validation: null,
        };
      }
      startSeconds = parsed;
    }

    let endSeconds: number | undefined;
    if (endInput.trim() !== "") {
      const parsed = parseTimestampInput(endInput);
      if (parsed === null) {
        return {
          parseError:
            "End time must be whole seconds (e.g. 150, 02:30, or 01:05:00).",
          startSeconds,
          endSeconds: undefined,
          validation: null,
        };
      }
      endSeconds = parsed;
    }

    const validation = resolveTimeRange({
      startSeconds,
      endSeconds,
      durationSeconds: sourceVideo.durationSeconds,
    });

    return {
      parseError: null,
      startSeconds,
      endSeconds,
      validation,
    };
  }, [sourceVideo, startInput, endInput]);

  const effectiveQuality = useMemo(() => {
    if (!sourceVideo) return qualityCap;
    return Math.min(qualityCap, sourceVideo.maxShortEdge);
  }, [sourceVideo, qualityCap]);

  const defaultFilenamePlaceholder = useMemo(() => {
    if (!sourceVideo) return "";
    const start = parsedRange.validation?.ok
      ? parsedRange.validation.timeRange.startSeconds
      : 0;
    const end = parsedRange.validation?.ok
      ? parsedRange.validation.timeRange.endSeconds
      : sourceVideo.durationSeconds;
    return buildDefaultClipFilename({
      title: sourceVideo.title,
      startSeconds: start,
      endSeconds: end,
      effectiveQuality,
    });
  }, [sourceVideo, parsedRange.validation, effectiveQuality]);

  const sliderStart = useMemo(() => {
    if (!sourceVideo) return 0;
    if (parsedRange.startSeconds !== undefined) {
      return Math.max(0, Math.min(sourceVideo.durationSeconds - 1, parsedRange.startSeconds));
    }
    return 0;
  }, [sourceVideo, parsedRange.startSeconds]);

  const sliderEnd = useMemo(() => {
    if (!sourceVideo) return 1;
    if (parsedRange.endSeconds !== undefined) {
      return Math.max(1, Math.min(sourceVideo.durationSeconds, parsedRange.endSeconds));
    }
    return sourceVideo.durationSeconds;
  }, [sourceVideo, parsedRange.endSeconds]);

  const handleInspect = async (e: FormEvent) => {
    e.preventDefault();
    setInspectError(null);
    setJobError(null);

    const normalized = normalizeYouTubeUrl(urlInput);
    if (!normalized.ok) {
      setInspectError(normalized.message);
      return;
    }

    setInspecting(true);
    try {
      const video = await inspectVideo(urlInput);
      setSourceVideo(video);
      setStartInput(
        video.initialStartSeconds !== null
          ? formatTimestamp(video.initialStartSeconds)
          : "",
      );
      setEndInput("");
      setCustomFilename("");
      setQualityCap(1080);
    } catch (err) {
      setSourceVideo(null);
      setInspectError(
        err instanceof Error ? err.message : "Failed to inspect YouTube URL.",
      );
    } finally {
      setInspecting(false);
    }
  };

  const handleStartJob = async () => {
    if (!sourceVideo || !parsedRange.validation?.ok || parsedRange.parseError) {
      return;
    }

    setJobError(null);
    setStartingJob(true);
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;

    try {
      const created = await createClipJob({
        url: sourceVideo.canonicalUrl,
        startSeconds: parsedRange.startSeconds,
        endSeconds: parsedRange.endSeconds,
        qualityCap,
        filename: customFilename.trim() || undefined,
      });

      setActiveJob({
        jobId: created.jobId,
        filename: created.filename,
        notices: created.notices,
        event: {
          type: "progress",
          jobId: created.jobId,
          state: "downloading",
          percent: 0,
          detail: "Starting download...",
        },
      });

      unsubscribeRef.current = subscribeToJobEvents(
        created.jobId,
        (event) => {
          setActiveJob((prev) =>
            prev && prev.jobId === event.jobId
              ? {
                  ...prev,
                  event,
                  notices: event.type === "ready" ? event.notices : prev.notices,
                }
              : prev,
          );
          if (event.type === "cancelled" || event.type === "ready" || event.type === "failed") {
            setCancelling(false);
          }
        },
        () => {
          setActiveJob((prev) =>
            prev && prev.event.type === "progress"
              ? {
                  ...prev,
                  event: {
                    type: "failed",
                    jobId: prev.jobId,
                    code: "STREAM_DISCONNECTED",
                    message: "Lost connection to the local server.",
                  },
                }
              : prev,
          );
          setCancelling(false);
        },
      );
    } catch (err) {
      if (err instanceof ApiError) {
        setJobError(err.message);
      } else {
        setJobError(
          err instanceof Error ? err.message : "Could not start Clip Job.",
        );
      }
    } finally {
      setStartingJob(false);
    }
  };

  const handleCancelJob = async () => {
    if (!activeJob) return;
    setCancelling(true);
    try {
      await cancelOrDeleteJob(activeJob.jobId);
    } catch (err) {
      setJobError(
        err instanceof Error ? err.message : "Failed to cancel Clip Job.",
      );
      setCancelling(false);
    }
  };

  const missingBinaries = useMemo(() => {
    if (!health || health.ok) return [];
    const list: string[] = [];
    if (!health.ytDlp.available) list.push("yt-dlp");
    if (!health.ffmpeg.available) list.push("ffmpeg");
    if (!health.ffprobe.available) list.push("ffprobe");
    return list;
  }, [health]);

  const canCreateClip =
    Boolean(sourceVideo) &&
    Boolean(health?.ok ?? true) &&
    !isJobRunning &&
    !parsedRange.parseError &&
    Boolean(parsedRange.validation?.ok);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6">
        {/* Header */}
        <header className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/15 ring-1 ring-indigo-500/30">
              <Scissors className="h-5 w-5 text-indigo-400" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">YT Clipper</h1>
              <p className="text-xs text-zinc-400">
                Frame-accurate 720p–1080p H.264 MP4 clips from YouTube
              </p>
            </div>
          </div>

          {health?.ok && (
            <span className="hidden rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300 sm:inline-flex">
              yt-dlp {health.ytDlp.version} · ffmpeg ready
            </span>
          )}
        </header>

        {/* Missing dependency banner */}
        {!healthLoading && missingBinaries.length > 0 && (
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" />
              <div className="space-y-1">
                <p className="font-semibold">
                  Missing required local tools: {missingBinaries.join(", ")}
                </p>
                <p className="text-xs text-rose-200/80">
                  Ensure <code className="font-mono">yt-dlp</code> and{" "}
                  <code className="font-mono">ffmpeg</code> are installed on your
                  PATH (e.g.{" "}
                  <code className="font-mono">
                    winget install yt-dlp.yt-dlp yt-dlp.FFmpeg
                  </code>
                  ), then re-check.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void loadHealth(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-400/40 bg-rose-500/20 px-3 py-1.5 text-xs font-medium text-rose-100 hover:bg-rose-500/30"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Re-check
            </button>
          </div>
        )}

        {/* URL Inspect Form */}
        <form onSubmit={handleInspect} className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={urlInput}
              disabled={inspecting || isJobRunning}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="Paste a YouTube video, Short, or archived VOD URL..."
              className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={inspecting || isJobRunning || !urlInput.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {inspecting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Inspecting...
                </>
              ) : (
                <>
                  <Search className="h-4 w-4" />
                  Inspect
                </>
              )}
            </button>
          </div>

          {inspectError && (
            <p className="text-xs text-rose-400" role="alert">
              {inspectError}
            </p>
          )}
        </form>

        {/* Source Video Preview & Clip Controls */}
        {sourceVideo && (
          <div className="space-y-5">
            {/* Source Video Header */}
            <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="space-y-0.5">
                  <h2 className="text-base font-semibold leading-snug text-zinc-100">
                    {sourceVideo.title}
                  </h2>
                  <p className="text-xs text-zinc-400">
                    {sourceVideo.uploader ? `${sourceVideo.uploader} · ` : ""}
                    Duration {formatTimestamp(sourceVideo.durationSeconds)} · Max{" "}
                    {sourceVideo.maxShortEdge}p
                    {sourceVideo.isVertical ? " (Vertical Short)" : ""}
                  </p>
                </div>
                <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800/80 px-2.5 py-0.5 text-xs font-medium text-zinc-300">
                  <Film className="h-3.5 w-3.5 text-indigo-400" />
                  MP4 · H.264/AAC
                </span>
              </div>

              {sourceVideo.strippedPlaylist && (
                <p className="text-xs text-zinc-400">
                  Playlist parameters were ignored — only this single Source Video
                  will be clipped.
                </p>
              )}

              {sourceVideo.below720pWarning && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-200">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                  <span>
                    This Source Video&apos;s highest available quality is{" "}
                    <strong>{sourceVideo.maxShortEdge}p</strong> (below 720p).
                    YT Clipper will fall back to {sourceVideo.maxShortEdge}p.
                  </span>
                </div>
              )}
            </div>

            {/* Embedded YouTube Player */}
            <YouTubePreview
              sourceVideo={sourceVideo}
              startSeconds={sliderStart}
              endSeconds={sliderEnd}
              disabled={isJobRunning}
              onCaptureStart={(sec) => setStartInput(formatTimestamp(sec))}
              onCaptureEnd={(sec) => setEndInput(formatTimestamp(sec))}
            />

            {/* Time Range */}
            <TimeRangeControls
              durationSeconds={sourceVideo.durationSeconds}
              startInput={startInput}
              endInput={endInput}
              sliderStart={sliderStart}
              sliderEnd={sliderEnd}
              disabled={isJobRunning}
              validation={parsedRange.validation}
              parseError={parsedRange.parseError}
              onStartInputChange={setStartInput}
              onEndInputChange={setEndInput}
              onSliderStartChange={(sec) =>
                setStartInput(sec === 0 ? "" : formatTimestamp(sec))
              }
              onSliderEndChange={(sec) =>
                setEndInput(
                  sec === sourceVideo.durationSeconds ? "" : formatTimestamp(sec),
                )
              }
              onResetFull={() => {
                setStartInput("");
                setEndInput("");
              }}
            />

            {/* Quality Cap & Filename */}
            <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="h-4 w-4 text-indigo-400" />
                <h2 className="text-sm font-semibold text-zinc-100">
                  Quality Cap & Filename
                </h2>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-zinc-300">
                    Quality Cap
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    {([1080, 720] as const).map((cap) => {
                      const active = qualityCap === cap;
                      return (
                        <button
                          key={cap}
                          type="button"
                          disabled={isJobRunning}
                          onClick={() => setQualityCap(cap)}
                          className={`rounded-lg border px-3 py-2 text-sm font-semibold transition disabled:opacity-50 ${
                            active
                              ? "border-indigo-500 bg-indigo-500/20 text-indigo-200"
                              : "border-zinc-700 bg-zinc-950 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                          }`}
                        >
                          {cap}p
                          {cap === 1080 ? (
                            <span className="ml-1 text-[10px] font-normal opacity-75">
                              default
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-zinc-300">
                    Output filename{" "}
                    <span className="font-normal text-zinc-500">(optional)</span>
                  </span>
                  <input
                    type="text"
                    value={customFilename}
                    disabled={isJobRunning}
                    onChange={(e) => setCustomFilename(e.target.value)}
                    placeholder={defaultFilenamePlaceholder}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800/80 pt-3">
                <span className="text-xs text-zinc-400">
                  Effective output:{" "}
                  <strong className="text-zinc-200">{effectiveQuality}p</strong> MP4
                  (H.264 + 192k AAC)
                </span>

                <button
                  type="button"
                  disabled={!canCreateClip}
                  onClick={() => void handleStartJob()}
                  className="inline-flex items-center gap-2 rounded-xl bg-indigo-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {startingJob ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Starting...
                    </>
                  ) : (
                    <>
                      <Scissors className="h-4 w-4" />
                      Create Clip
                    </>
                  )}
                </button>
              </div>

              {jobError && (
                <p className="text-xs text-rose-400" role="alert">
                  {jobError}
                </p>
              )}
            </section>
          </div>
        )}

        {/* Active / Completed Clip Job Progress */}
        {activeJob && (
          <ClipJobPanel
            job={activeJob}
            cancelling={cancelling}
            onCancel={() => void handleCancelJob()}
          />
        )}
      </div>
    </div>
  );
}
