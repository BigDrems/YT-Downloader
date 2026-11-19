# YT Clipper — Specification

**References:**
- Domain vocabulary: [GLOSSARY.md](../GLOSSARY.md)
- Decisions: [ADR-0001: Re-encode clipped segments to H.264 + AAC MP4](adr/0001-reencode-for-frame-accurate-mp4.md), [ADR-0002: Stateless local web app with TypeScript Node.js and React/Vite](adr/0002-local-web-app-stateless-architecture.md)

---

## 1. Problem Statement

Downloading a specific excerpt from a YouTube video as a clean, universally playable 720p–1080p MP4 clip is needlessly clunky: web downloaders are ad-ridden, rate-limited, or downgrade quality; raw CLI workflows require manually finding timestamps, crafting `yt-dlp` format filters (which easily mishandle vertical Shorts or 4K streams), and running a second `ffmpeg` pass to fix keyframe-snapped cuts and VP9/AV1/Opus compatibility issues.

## 2. Solution

**YT Clipper** is a personal local web app running on `localhost` that wraps locally installed `yt-dlp` and `ffmpeg` binaries behind a dark-mode single-page UI. You paste a YouTube URL, preview the **Source Video** in an embedded player (or thumbnail fallback) to pick a **Time Range** and **Quality Cap** (`1080p` or `720p`), watch live download and encoding progress for a single active **Clip Job**, and download a frame-accurate H.264 + AAC MP4 **Clip** straight through your browser with automatic temporary-file cleanup.

---

## 3. User Stories

1. As a user, I want to paste a standard YouTube video, Short, or archived livestream VOD URL and inspect its metadata, so that I can verify the **Source Video** title, duration, and available quality before downloading.
2. As a user, I want pure playlist URLs, active livestreams, and authenticated private videos to be clearly rejected during inspection, so that I immediately know why a link cannot be clipped.
3. As a user, I want a video URL that contains a `&list=` parameter to inspect only that single video, so that pasting a link from a playlist never triggers a playlist download.
4. As a user, I want a video URL containing a `&t=` timestamp parameter to automatically pre-fill my **Time Range** start bound, so that I don't have to re-type a timestamp already in the link.
5. As a user, I want to scrub the **Source Video** in an embedded YouTube player and click "Set Start" / "Set End" from the current playback time, so that I can pick exact timestamps visually.
6. As a user, I want to type start and end times manually (`MM:SS`, `HH:MM:SS`, or raw seconds) or adjust a range slider, so that I can enter or fine-tune a **Time Range** quickly.
7. As a user, I want an embed-blocked **Source Video** to fall back gracefully to its thumbnail and a short notice while keeping manual timestamp controls usable, so that uploader embed restrictions never block clipping.
8. As a user, I want either or both **Time Range** bounds to be optional (defaulting to `00:00` and the video's end), so that I can easily clip from a point to the end or download the full video.
9. As a user, I want invalid ranges (`start >= end` or shorter than 1 second) rejected before starting a **Clip Job**, and an `end` bound past the video's duration clamped to the video's end with a clear notice, so that small typos don't cause confusing failures.
10. As a user, I want a non-blocking warning if my **Time Range** exceeds 30 minutes, so that I know local re-encoding will take longer without being artificially blocked.
11. As a user, I want to choose a **Quality Cap** of `1080p` (default) or `720p`, so that I control file size and resolution without ever downloading 4K streams.
12. As a user, I want **Quality Cap** matched against the video's short edge (`min(width, height)`), so that vertical YouTube Shorts stay at true `1080p` or `720p` instead of being downgraded.
13. As a user, I want **Source Videos** whose maximum short-edge resolution is below `720p` to fall back to the highest available resolution with a notice shown during inspection, so that older videos still clip cleanly.
14. As a user, I want my **Clip** cut with frame accuracy and encoded as 8-bit `yuv420p` H.264 + stereo AAC MP4 preserving the source framerate, so that the file plays reliably across Windows Photos, QuickTime, Discord, mobile devices, and video editors.
15. As a user, I want long **Source Videos** downloaded only around my requested **Time Range** rather than in full, so that extracting a short clip from a 2-hour VOD finishes quickly.
16. As a user, I want an automatic fallback to full download if partial section downloading fails on a short **Source Video** (`<= 15 minutes`), while failing cleanly on longer videos, so that short clips recover reliably without unexpectedly pulling gigabytes.
17. As a user, I want an auto-generated Windows-safe filename (`{title}_{start}-{end}_{quality}.mp4`) that I can optionally override before starting, so that downloaded **Clips** are immediately recognizable.
18. As a user, I want live stage and percentage progress (`Downloading → Encoding → Ready`) while my **Clip Job** runs, so that I can see what the app is doing.
19. As a user, I want to cancel an active **Clip Job** at any time and have the app terminate `yt-dlp`/`ffmpeg` and remove partial temp files, so that I can change my mind cleanly without orphaned processes or leftover files.
20. As a user, I want finished **Clips** delivered via browser download and cleaned up automatically from temporary storage on server start/exit, when a new **Clip Job** starts, or after 30 minutes of inactivity, so that disk usage stays clean without duplicate files.
21. As a user, I want an immediate startup health indicator if `yt-dlp` or `ffmpeg` is missing (and clear guidance if `yt-dlp` is outdated), so that environment issues are easy to diagnose.

---

## 4. Architecture & Module Boundaries

Single-package TypeScript repository managed with `pnpm`:

- **Shared Domain Module** (`src/shared/`): Pure, zero-I/O TypeScript types, Zod schemas, and domain helpers shared by client and server:
  - YouTube URL normalization & validation (video ID extraction, `&list=` stripping, `&t=` parsing, pure playlist rejection).
  - **Time Range** parsing, formatting, validation (`< 1s`, `start >= end`), end-clamping, and `> 30 min` warning logic.
  - **Quality Cap** short-edge resolution selection and `< 720p` fallback calculation.
  - Output filename generation & Windows-safe sanitization.
  - API request/response and SSE event payload schemas.
- **Server Module** (`src/server/`): Node.js HTTP API server (e.g., Hono on `@hono/node-server` or Express):
  - **Health Service**: Checks `yt-dlp`, `ffmpeg`, and `ffprobe` availability and versions at startup and on demand.
  - **Inspector Service**: Invokes `yt-dlp --dump-single-json --no-playlist` to extract **Source Video** metadata (title, duration, thumbnail, live status, available video formats with `width`/`height`/`fps`).
  - **Media Runner Seam**: Narrow interface encapsulating `yt-dlp` segment/full download and `ffmpeg` frame-accurate trim + H.264/AAC re-encode, reporting structured progress callbacks and supporting `AbortSignal` process-tree termination.
  - **Clip Job Manager**: Enforces single active **Clip Job** concurrency (`409 Conflict` if busy), tracks state machine (`downloading` → `encoding` → `ready` | `cancelled` | `failed`), publishes SSE updates, and coordinates temp-directory lifecycle & 30-minute TTL sweeping.
  - **Static Hosting**: Serves the built Vite client bundle on the same `localhost` port in production (`pnpm start`).
- **Client Module** (`src/client/`): React + Vite + Tailwind CSS dark-mode single-page app:
  - Startup health banner (when `yt-dlp` or `ffmpeg` is unavailable).
  - URL input & inspect flow.
  - Embedded YouTube iframe player with "Set Start" / "Set End" capture buttons, automatic fallback to thumbnail + note on embed error.
  - **Time Range** controls (start/end inputs, dual-handle range slider, validation & notices).
  - **Quality Cap** selector (`1080p` / `720p`), filename override input, and Start/Cancel button.
  - Live **Clip Job** progress panel (stage badge, progress bar, notices/errors, Download **Clip** CTA when `ready`).

---

## 5. API Contracts

All endpoints live under `/api`:

| Endpoint | Method | Purpose | Key Responses |
|---|---|---|---|
| `/api/health` | `GET` | Check local binary readiness | `200 { ok, ytDlp: { available, version }, ffmpeg: { available, version } }` |
| `/api/inspect` | `POST` | Validate URL and fetch **Source Video** metadata | `200 { videoId, canonicalUrl, title, durationSeconds, thumbnailUrl, initialStartSeconds?, maxShortEdge, availableQualityCaps, below720pWarning }` <br> `400` invalid/playlist URL; `422` active livestream or private/unavailable video |
| `/api/jobs` | `POST` | Start a new **Clip Job** (cleans up previous completed **Clip**) | Body: `{ url, startSeconds?, endSeconds?, qualityCap: 720 \| 1080, filename? }` <br> `201 { jobId, filename, resolvedTimeRange, notices }` <br> `400` validation error; `409` another **Clip Job** is already active |
| `/api/jobs/:jobId/events` | `GET` | SSE stream of live **Clip Job** state & progress | Events: `progress` (`{ state, percent, detail? }`), `ready` (`{ jobId, filename, effectiveQuality, downloadUrl, sizeBytes }`), `cancelled`, `failed` (`{ code, message }`) |
| `/api/jobs/:jobId` | `DELETE` | Cancel active **Clip Job** or discard finished **Clip** | `200 { status: "cancelled" \| "deleted" }` |
| `/api/clips/:jobId` | `GET` | Stream finished MP4 **Clip** with `Content-Disposition: attachment` | `200 video/mp4`; `404` if expired/cleaned up |

---

## 6. Media Pipeline & Edge-Case Rules

### 6.1 URL Normalization
- Accept `youtube.com/watch?v=<id>`, `youtu.be/<id>`, `youtube.com/shorts/<id>`, `youtube.com/live/<id>`, and mobile `m.youtube.com` equivalents.
- Reject `youtube.com/playlist?list=...` (no video ID) with an explicit message that playlists are unsupported.
- Strip `&list=` / `&index=` and always pass `--no-playlist` to `yt-dlp`.
- Parse `&t=` / `&start=` (supports `90`, `90s`, `1m30s`, `1h2m3s`) and return as `initialStartSeconds` to pre-fill the UI Start input.

### 6.2 Quality Cap & Format Selection
- Short-edge resolution of a video stream is `min(width, height)` (handles both `1920×1080` landscape and `1080×1920` vertical Shorts identically).
- Select the highest-resolution video stream whose short edge is `<= Quality Cap` (capped at `<= 1080`), paired with the best audio stream.
- If no video stream has short edge `>= 720`, select the highest available short-edge stream and surface a `< 720p` fallback notice during inspection and job summary.
- Preserve source framerate (do not force `-r 30`).

### 6.3 Two-Stage Download & Frame-Accurate Encode
1. **Stage 1 — Downloading (`yt-dlp`)**:
   - Compute a padded download window `[max(0, start - 10), min(duration, end + 10)]` when a partial **Time Range** is requested.
   - Run `yt-dlp --no-playlist --download-sections "*<padStart>-<padEnd>"` targeting the selected video + audio format into a job-scoped temp directory.
   - Parse `yt-dlp` progress lines to emit `downloading` percentage updates.
   - **Fallback**: If `--download-sections` fails and `Source Video` duration is `<= 900s` (15 minutes), automatically retry downloading the full **Source Video** (adjusting trim offset accordingly) and emit a status notice. If duration is `> 900s`, fail cleanly with an actionable error instead of downloading gigabytes.
2. **Stage 2 — Encoding (`ffmpeg`)**:
   - Trim accurately from the downloaded media to the exact requested **Time Range** (`start` to `end`, accounting for any padded window start timestamp via `ffprobe` or media start offset).
   - Encode with:
     - Video: `-c:v libx264 -crf 20 -preset fast -pix_fmt yuv420p`
     - Audio: `-c:a aac -b:a 192k -ac 2`
     - Container & tracks: `-map 0:v:0 -map 0:a:0? -sn -dn -map_chapters -1 -movflags +faststart`
   - Emit `encoding` percentage updates using `ffmpeg -progress pipe:1` (`out_time_us / expectedDurationUs`).
   - Output video + audio only (handles rare audio-less videos gracefully with optional audio map).

### 6.4 Filename Sanitization
- Default pattern: `{sanitizedTitle}_{startTag}-{endTag}_{effectiveQuality}p.mp4` (e.g. `Demo_Talk_01m10s-02m30s_1080p.mp4`).
- Strip Windows-illegal characters (`<>:"/\|?*` and control characters), collapse whitespace, avoid Windows reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`LPT9`), cap base name length (e.g. 120 chars), and ensure `.mp4` extension.

### 6.5 Cancellation & Temp Cleanup
- Temp workspace resides under an app-scoped temp folder (e.g. `os.tmpdir()/yt-clipper/`).
- Cancelling a **Clip Job** sends termination to the entire child process tree (using `taskkill /pid <pid> /T /F` on Windows / `SIGTERM` fallback) and removes the job's temp folder once processes exit.
- Cleanup runs automatically on:
  1. Server startup (removes any stale directories from a prior crash).
  2. Server shutdown (`SIGINT` / `SIGTERM`).
  3. Start of a new **Clip Job** (clears previous completed **Clip**).
  4. 30-minute inactivity timer after a **Clip Job** reaches `ready`.

---

## 7. Testing Strategy & Seams

Tests run via **Vitest** with zero YouTube network calls, targeting external behavior across two clean seams:

1. **Pure Domain & Contract Tests** (`src/shared/`):
   - URL normalization (standard, `youtu.be`, Shorts, VOD, `&list=` stripping, `&t=` formats, pure playlist rejection, non-YouTube URL rejection).
   - **Time Range** parsing (`MM:SS`, `HH:MM:SS`, raw seconds), validation (`start >= end`, `< 1s`), `end > duration` clamping notice, optional bounds defaulting, `> 30 min` warning.
   - **Quality Cap** format selection across landscape 4K/1080p/720p, vertical `1080×1920` Shorts, `60fps` preservation, and `< 720p` fallback.
   - Windows-safe filename generation and custom filename sanitization.
2. **Clip Job Manager & API Seam Tests** (`src/server/`):
   - Exercise HTTP routes and **Clip Job Manager** against a fake `MediaRunner` seam (single-active-job `409` enforcement, `downloading → encoding → ready` SSE lifecycle, cancellation mid-download and mid-encode, `<= 15 min` full-download fallback vs `> 15 min` failure, temp-folder cleanup on new job and expiry).
3. **Offline `ffmpeg` Integration Smoke Test**:
   - Generates a tiny 6-second synthetic test video (`testsrc2` + `sine` audio, VP9/WebM or Matroska) using local `ffmpeg`, runs the real encoder module to cut `00:01`–`00:04`, and verifies via `ffprobe` that the resulting MP4 uses H.264 (`yuv420p`) + stereo AAC, has `~3.0s` duration, and contains no subtitle/chapter streams.

---

## 8. Out of Scope (v1)

- Public/multi-user hosting, authentication, or rate limiting.
- Extracting multiple **Clips** from one video in a single request, or batch-queuing multiple URLs.
- Active livestream / DVR clipping.
- Browser-cookie authentication for private, members-only, or age-restricted videos.
- Subtitles, burned-in captions, chapter markers, or embedded cover thumbnails.
- Persistent clip history, database storage, or custom local save directories beyond browser download.
- GPU hardware encoding (NVENC/QuickSync/AMF) or user-configurable CRF/preset sliders.
- Desktop app packaging (Electron/Tauri) or standalone CLI mode.
