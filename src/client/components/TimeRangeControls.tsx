import { AlertTriangle, Clock } from "lucide-react";
import {
  formatTimestamp,
  type ResolveTimeRangeResult,
} from "../../shared/index.js";

interface TimeRangeControlsProps {
  durationSeconds: number;
  startInput: string;
  endInput: string;
  sliderStart: number;
  sliderEnd: number;
  disabled: boolean;
  validation: ResolveTimeRangeResult | null;
  parseError: string | null;
  onStartInputChange: (value: string) => void;
  onEndInputChange: (value: string) => void;
  onSliderStartChange: (seconds: number) => void;
  onSliderEndChange: (seconds: number) => void;
  onResetFull: () => void;
}

export function TimeRangeControls({
  durationSeconds,
  startInput,
  endInput,
  sliderStart,
  sliderEnd,
  disabled,
  validation,
  parseError,
  onStartInputChange,
  onEndInputChange,
  onSliderStartChange,
  onSliderEndChange,
  onResetFull,
}: TimeRangeControlsProps) {
  const safeDuration = Math.max(1, durationSeconds);
  const leftPercent = (Math.min(sliderStart, safeDuration) / safeDuration) * 100;
  const rightPercent = (Math.min(sliderEnd, safeDuration) / safeDuration) * 100;

  return (
    <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-indigo-400" />
          <h2 className="text-sm font-semibold text-zinc-100">Time Range</h2>
          {validation?.ok && (
            <span className="rounded-full bg-indigo-500/15 px-2.5 py-0.5 font-mono text-xs text-indigo-300">
              Clip length: {formatTimestamp(validation.timeRange.clipDurationSeconds)}
            </span>
          )}
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={onResetFull}
          className="text-xs text-zinc-400 transition hover:text-zinc-200 disabled:opacity-40"
        >
          Reset to full video
        </button>
      </div>

      {/* Dual-handle range slider */}
      <div className="space-y-1.5 pt-1">
        <div className="relative flex h-6 items-center">
          <div className="h-1.5 w-full rounded-full bg-zinc-800" />
          <div
            className="pointer-events-none absolute h-1.5 rounded-full bg-indigo-500"
            style={{
              left: `${leftPercent}%`,
              width: `${Math.max(0, rightPercent - leftPercent)}%`,
            }}
          />
          <input
            type="range"
            aria-label="Start time slider"
            min={0}
            max={Math.max(0, safeDuration - 1)}
            step={1}
            value={Math.min(sliderStart, Math.max(0, safeDuration - 1))}
            disabled={disabled}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              onSliderStartChange(Math.min(next, Math.max(0, sliderEnd - 1)));
            }}
            className="range-thumb pointer-events-none absolute inset-0 h-6 w-full appearance-none bg-transparent"
          />
          <input
            type="range"
            aria-label="End time slider"
            min={1}
            max={safeDuration}
            step={1}
            value={Math.max(1, Math.min(sliderEnd, safeDuration))}
            disabled={disabled}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              onSliderEndChange(Math.max(next, Math.min(safeDuration, sliderStart + 1)));
            }}
            className="range-thumb pointer-events-none absolute inset-0 h-6 w-full appearance-none bg-transparent"
          />
        </div>
        <div className="flex justify-between font-mono text-[11px] text-zinc-500">
          <span>00:00</span>
          <span>{formatTimestamp(durationSeconds)}</span>
        </div>
      </div>

      {/* Manual inputs */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-zinc-300">
            Start time <span className="font-normal text-zinc-500">(optional, defaults to 00:00)</span>
          </span>
          <input
            type="text"
            value={startInput}
            disabled={disabled}
            onChange={(e) => onStartInputChange(e.target.value)}
            placeholder="00:00"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-zinc-300">
            End time{" "}
            <span className="font-normal text-zinc-500">
              (optional, defaults to {formatTimestamp(durationSeconds)})
            </span>
          </span>
          <input
            type="text"
            value={endInput}
            disabled={disabled}
            onChange={(e) => onEndInputChange(e.target.value)}
            placeholder={formatTimestamp(durationSeconds)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
          />
        </label>
      </div>

      {parseError && (
        <p className="text-xs text-rose-400" role="alert">
          {parseError}
        </p>
      )}

      {!parseError && validation && !validation.ok && (
        <p className="text-xs text-rose-400" role="alert">
          {validation.message}
        </p>
      )}

      {!parseError && validation?.ok && validation.notices.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-200">
          {validation.notices.map((notice) => (
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
