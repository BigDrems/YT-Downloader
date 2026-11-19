# YT Clipper

A personal local tool for extracting bounded MP4 video clips from YouTube videos within a controlled 720p–1080p quality range.

## Language

**Source Video**:
A public or unlisted YouTube video—standard video, Short, or archived livestream VOD—from which a clip can be extracted. Active livestreams and authenticated private videos are excluded.
_Avoid_: URL, link, stream, media

**Time Range**:
Whole-second start and end timestamps defining a portion of at least one second within a Source Video. Either or both bounds may be omitted (defaulting to the video's start or end), and an end bound past the video's duration is clamped to the end.
_Avoid_: Cut window, segment, interval, trim

**Quality Cap**:
The maximum target short-edge resolution (`720p` or `1080p`) requested for a Clip, so both landscape videos and vertical Shorts keep their intended resolution tier. If a Source Video's highest available short-edge resolution is below `720p`, the highest available resolution is used instead.
_Avoid_: Resolution, preset, format

**Clip**:
The finished video-and-audio MP4 file produced from a single Source Video, Time Range, and Quality Cap, delivered via browser download and held only temporarily on disk.
_Avoid_: Video, download, export, cut

**Clip Job**:
A single active execution that produces one Clip from a Source Video, Time Range, and Quality Cap. Only one Clip Job may run at a time, and an in-progress Clip Job may be cancelled.
_Avoid_: Task, process, worker, run

