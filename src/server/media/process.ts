import { spawn } from "node:child_process";

export class ProcessAbortedError extends Error {
  readonly code = "ABORTED";
  constructor(message = "Process was cancelled.") {
    super(message);
    this.name = "ProcessAbortedError";
  }
}

export class ProcessExitError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(command: string, exitCode: number | null, stderr: string) {
    super(
      `${command} exited with code ${exitCode ?? "unknown"}${stderr ? `: ${stderr.slice(-400)}` : ""}`,
    );
    this.name = "ProcessExitError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resolve();
      return;
    }

    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => resolve());
      killer.on("close", () => resolve());
      return;
    }

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited.
    }
    resolve();
  });
}

export interface RunCommandOptions {
  cwd?: string;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
}

function attachLineReader(
  stream: NodeJS.ReadableStream,
  onChunk: (text: string) => void,
  onLine?: (line: string) => void,
): { flush: () => void } {
  let buffer = "";

  stream.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    onChunk(text);
    if (!onLine) return;

    buffer += text;
    const lines = buffer.split(/\r\n|\n|\r/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) {
        onLine(line);
      }
    }
  });

  return {
    flush: () => {
      if (onLine && buffer.length > 0) {
        onLine(buffer);
        buffer = "";
      }
    },
  };
}

export function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ProcessAbortedError());
      return;
    }

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let aborted = false;

    const stdoutReader = attachLineReader(
      child.stdout,
      (text) => {
        stdout += text;
      },
      options.onStdoutLine,
    );

    const stderrReader = attachLineReader(
      child.stderr,
      (text) => {
        stderr += text;
      },
      options.onStderrLine,
    );

    const onAbort = () => {
      aborted = true;
      if (child.pid) {
        void killProcessTree(child.pid);
      } else {
        child.kill("SIGKILL");
      }
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });

    child.on("close", (code) => {
      stdoutReader.flush();
      stderrReader.flush();
      cleanup();

      if (aborted) {
        reject(new ProcessAbortedError());
        return;
      }

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new ProcessExitError(command, code, stderr.trim()));
    });
  });
}
