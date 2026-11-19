import { useEffect, useRef, useState } from "react";
import { AlertCircle, CornerDownLeft, CornerDownRight, Play } from "lucide-react";
import { formatTimestamp, type SourceVideo } from "../../shared/index.js";

interface YTPlayerInstance {
  getCurrentTime?: () => number;
  seekTo?: (seconds: number, allowSeekAhead: boolean) => void;
  destroy?: () => void;
}

interface YTNamespace {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onError?: (event: { data: number }) => void;
      };
    },
  ) => YTPlayerInstance;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytApiPromise: Promise<YTNamespace> | null = null;

function loadYouTubeIframeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise<YTNamespace>((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[src="https://www.youtube.com/iframe_api"]',
    );
    const prevCallback = window.onYouTubeIframeAPIReady;

    window.onYouTubeIframeAPIReady = () => {
      prevCallback?.();
      if (window.YT?.Player) {
        resolve(window.YT);
      } else {
        reject(new Error("YouTube IFrame API loaded without YT.Player"));
      }
    };

    if (!existingScript) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => reject(new Error("Failed to load YouTube IFrame API"));
      document.head.appendChild(script);
    }
  });

  return ytApiPromise;
}

interface YouTubePreviewProps {
  sourceVideo: SourceVideo;
  startSeconds: number;
  endSeconds: number;
  disabled: boolean;
  onCaptureStart: (seconds: number) => void;
  onCaptureEnd: (seconds: number) => void;
}

export function YouTubePreview({
  sourceVideo,
  startSeconds,
  endSeconds,
  disabled,
  onCaptureStart,
  onCaptureEnd,
}: YouTubePreviewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayerInstance | null>(null);
  const [embedBlocked, setEmbedBlocked] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    let active = true;
    setEmbedBlocked(false);
    setPlayerReady(false);
    setCurrentTime(0);

    loadYouTubeIframeApi()
      .then((YT) => {
        if (!active || !hostRef.current) return;
        hostRef.current.innerHTML = "";
        const mountNode = document.createElement("div");
        mountNode.className = "w-full h-full";
        hostRef.current.appendChild(mountNode);

        playerRef.current = new YT.Player(mountNode, {
          videoId: sourceVideo.videoId,
          playerVars: {
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
          },
          events: {
            onReady: () => {
              if (!active) return;
              setPlayerReady(true);
            },
            onError: (evt) => {
              if (!active) return;
              // 101 / 150 = uploader blocked embedding; 2 / 5 / 100 = player unavailable
              if ([2, 5, 100, 101, 150].includes(evt.data)) {
                setEmbedBlocked(true);
              }
            },
          },
        });
      })
      .catch(() => {
        if (active) setEmbedBlocked(true);
      });

    return () => {
      active = false;
      playerRef.current?.destroy?.();
      playerRef.current = null;
    };
  }, [sourceVideo.videoId]);

  useEffect(() => {
    if (!playerReady || embedBlocked) return;
    const timer = window.setInterval(() => {
      const time = playerRef.current?.getCurrentTime?.();
      if (typeof time === "number" && Number.isFinite(time)) {
        setCurrentTime(Math.floor(time));
      }
    }, 350);
    return () => window.clearInterval(timer);
  }, [playerReady, embedBlocked]);

  const readCurrentSeconds = (): number => {
    const raw = playerRef.current?.getCurrentTime?.();
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return Math.max(0, Math.min(sourceVideo.durationSeconds, Math.floor(raw)));
    }
    return currentTime;
  };

  const seekTo = (seconds: number) => {
    playerRef.current?.seekTo?.(seconds, true);
    setCurrentTime(seconds);
  };

  return (
    <div className="space-y-3">
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-zinc-800 bg-black">
        {embedBlocked ? (
          <div className="relative flex h-full w-full flex-col items-center justify-center bg-zinc-900/80 p-4 text-center">
            {sourceVideo.thumbnailUrl && (
              <img
                src={sourceVideo.thumbnailUrl}
                alt={sourceVideo.title}
                className="absolute inset-0 h-full w-full object-cover opacity-30"
              />
            )}
            <div className="relative z-10 max-w-md rounded-xl border border-zinc-700/80 bg-zinc-950/90 p-4 backdrop-blur">
              <div className="mb-1.5 flex items-center justify-center gap-2 text-amber-400">
                <AlertCircle className="h-4 w-4" />
                <span className="text-sm font-medium">Embedded playback unavailable</span>
              </div>
              <p className="text-xs leading-relaxed text-zinc-300">
                The uploader disabled embedding for this Source Video. You can still
                clip it normally using the manual timestamps and range slider below.
              </p>
            </div>
          </div>
        ) : (
          <div ref={hostRef} className="h-full w-full" />
        )}
      </div>

      {!embedBlocked && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800/90 bg-zinc-900/60 px-3 py-2 text-xs">
          <div className="flex items-center gap-2 text-zinc-400">
            <Play className="h-3.5 w-3.5 text-indigo-400" />
            <span>
              Playhead:{" "}
              <span className="font-mono font-medium text-zinc-100">
                {formatTimestamp(currentTime)}
              </span>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!playerReady || disabled}
              onClick={() => onCaptureStart(readCurrentSeconds())}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 font-medium text-zinc-100 transition hover:border-indigo-500/70 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <CornerDownRight className="h-3.5 w-3.5 text-indigo-400" />
              Set Start
            </button>
            <button
              type="button"
              disabled={!playerReady || disabled}
              onClick={() => onCaptureEnd(readCurrentSeconds())}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 font-medium text-zinc-100 transition hover:border-indigo-500/70 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <CornerDownLeft className="h-3.5 w-3.5 text-indigo-400" />
              Set End
            </button>
            <button
              type="button"
              disabled={!playerReady}
              onClick={() => seekTo(startSeconds)}
              className="rounded-md px-2 py-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
              title="Seek player to Start Time"
            >
              Go to Start
            </button>
            <button
              type="button"
              disabled={!playerReady}
              onClick={() => seekTo(endSeconds)}
              className="rounded-md px-2 py-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
              title="Seek player to End Time"
            >
              Go to End
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
