# Re-encode clipped segments to H.264 + AAC MP4

YouTube serves most 720p–1080p streams as VP9/AV1 video with Opus audio and sparse keyframes (often 2–5 seconds apart). Rather than fast stream-copying (`-c copy`)—which snaps cuts to keyframes and produces MP4 files that fail in many editors and native players—we re-encode every clipped segment via `ffmpeg` to H.264 video and AAC audio in an MP4 container. This trades a few seconds of local CPU time per clip for frame-accurate cuts and universal MP4 playback compatibility.
