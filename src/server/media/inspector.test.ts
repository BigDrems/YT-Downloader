import { describe, expect, it } from "vitest";
import { classifyYtDlpStderr } from "./inspector.js";
import { parseYtDlpProgressLine } from "./runner.js";

describe("classifyYtDlpStderr", () => {
  it("detects private / age-restricted / auth errors", () => {
    expect(
      classifyYtDlpStderr("ERROR: [youtube] abc: Private video. Sign in if you've been granted access"),
    ).toMatchObject({ code: "PRIVATE_OR_AUTH_REQUIRED", httpStatus: 422 });

    expect(
      classifyYtDlpStderr("ERROR: Sign in to confirm your age. This video may be inappropriate"),
    ).toMatchObject({ code: "PRIVATE_OR_AUTH_REQUIRED", httpStatus: 422 });
  });

  it("detects active/upcoming livestreams", () => {
    expect(
      classifyYtDlpStderr("ERROR: This live event will begin in 2 hours."),
    ).toMatchObject({ code: "LIVESTREAM_UNSUPPORTED", httpStatus: 422 });
  });

  it("detects outdated yt-dlp / extraction failures", () => {
    expect(
      classifyYtDlpStderr("ERROR: Unable to extract uploader id; nsig extraction failed"),
    ).toMatchObject({ code: "YTDLP_OUTDATED_OR_FAILED", httpStatus: 502 });
  });
});

describe("parseYtDlpProgressLine", () => {
  it("extracts download percentage from yt-dlp progress output", () => {
    expect(
      parseYtDlpProgressLine("[download]  42.7% of   15.32MiB at    3.45MiB/s ETA 00:02"),
    ).toBe(42.7);
    expect(parseYtDlpProgressLine("[download] 100% of 10.00MiB in 00:01")).toBe(100);
    expect(parseYtDlpProgressLine("[Merger] Merging formats into source.mkv")).toBeNull();
  });
});
