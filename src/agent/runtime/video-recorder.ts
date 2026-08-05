// @ts-nocheck
import { spawn } from "node:child_process";
import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

type Size = { width: number; height: number };
type SpawnProcess = typeof spawn;

type VideoRecorderOptions = {
  outputPath: string;
  size: Size;
  ffmpegPath?: string;
  spawnProcess?: SpawnProcess;
  now?: () => number;
};

const FPS = 25;
const MAX_STDERR_LENGTH = 64 * 1024;

export class VideoRecorder {
  private _options: VideoRecorderOptions;
  private _process: any;
  private _exitPromise: Promise<any> | undefined;
  private _writePromise = Promise.resolve();
  private _firstFrameTimestamp: number | undefined;
  private _lastFrame:
    | { buffer: Buffer; timestamp: number; frameNumber: number }
    | undefined;
  private _lastFrameReceivedAt = 0;
  private _stderr = "";
  private _stdinError: Error | undefined;
  private _stopPromise: Promise<void> | undefined;
  private _tempOutputPath: string | undefined;

  constructor(options: VideoRecorderOptions) {
    this._options = options;
  }

  async start() {
    const { outputPath, size } = this._options;
    await mkdir(dirname(outputPath), { recursive: true });
    this._tempOutputPath = `${outputPath}.${process.pid}-${Math.random()
      .toString(16)
      .slice(2)}.webm`;
    const args = [
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-avioflags",
      "direct",
      "-fpsprobesize",
      "0",
      "-probesize",
      "32",
      "-analyzeduration",
      "0",
      "-c:v",
      "mjpeg",
      "-i",
      "pipe:0",
      "-y",
      "-an",
      "-r",
      "25",
      "-c:v",
      "vp8",
      "-qmin",
      "0",
      "-qmax",
      "50",
      "-crf",
      "8",
      "-deadline",
      "realtime",
      "-speed",
      "8",
      "-b:v",
      "1M",
      "-threads",
      "1",
      "-vf",
      `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`,
      this._tempOutputPath,
    ];
    const spawnProcess = this._options.spawnProcess ?? spawn;
    this._process = spawnProcess(
      this._options.ffmpegPath ??
        process.env.EGO_BROWSER_FFMPEG_PATH ??
        "ffmpeg",
      args,
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    this._exitPromise = new Promise((resolve) => {
      this._process.once("close", (code, signal) => resolve({ code, signal }));
      this._process.once("error", (error) => resolve({ error }));
    });
    this._process.stderr?.on("data", (chunk) => {
      this._stderr = `${this._stderr}${String(chunk)}`.slice(
        -MAX_STDERR_LENGTH,
      );
    });
    this._process.stdin?.on("error", (error) => {
      this._stdinError ??= error;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        this._process.once("spawn", resolve);
        this._process.once("error", reject);
      });
    } catch (error) {
      if ((error as any)?.code === "ENOENT") {
        throw new Error(
          "FFmpeg executable was not found. Install ffmpeg or set EGO_BROWSER_FFMPEG_PATH.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  writeFrame(buffer: Buffer, timestamp: number) {
    const frameNumber =
      this._firstFrameTimestamp !== undefined
        ? Math.floor(((timestamp - this._firstFrameTimestamp) * FPS) / 1000)
        : 0;
    if (this._lastFrame) {
      this._queueFrames(
        this._lastFrame.buffer,
        Math.max(0, frameNumber - this._lastFrame.frameNumber),
      );
    } else {
      this._firstFrameTimestamp = timestamp;
    }
    this._lastFrame = { buffer, timestamp, frameNumber };
    this._lastFrameReceivedAt = this._now();
    return this._writePromise;
  }

  stop() {
    this._stopPromise ??= this._stop();
    return this._stopPromise;
  }

  private async _stop() {
    if (this._lastFrame && this._firstFrameTimestamp !== undefined) {
      const elapsed = Math.max(this._now() - this._lastFrameReceivedAt, 1000);
      const finalFrameNumber = Math.floor(
        ((this._lastFrame.timestamp + elapsed - this._firstFrameTimestamp) *
          FPS) /
          1000,
      );
      this._queueFrames(
        this._lastFrame.buffer,
        Math.max(0, finalFrameNumber - this._lastFrame.frameNumber),
      );
    }
    let writeError;
    try {
      await this._writePromise;
    } catch (error) {
      writeError = error;
    }
    try {
      this._process.stdin.end();
    } catch (error) {
      this._stdinError ??= error as Error;
    }
    const result = await this._exitPromise;
    const failure = result?.error ?? writeError ?? this._stdinError;
    if (failure || result?.code !== 0) {
      await this._removeTempOutput();
      const detail = this._stderr.trim();
      const status = result?.error
        ? result.error.message
        : `exited with code ${result?.code}`;
      throw new Error(`ffmpeg ${status}${detail ? `: ${detail}` : ""}`, {
        cause: failure,
      });
    }
    try {
      await rename(this._tempOutputPath!, this._options.outputPath);
    } catch (error) {
      await this._removeTempOutput();
      throw error;
    }
  }

  private _queueFrames(buffer: Buffer, count: number) {
    this._writePromise = this._writePromise.then(async () => {
      for (let i = 0; i < count; i++) {
        await new Promise<void>((resolve, reject) => {
          this._process.stdin.write(buffer, (error) =>
            error ? reject(error) : resolve(),
          );
        });
      }
    });
  }

  private _now() {
    return (this._options.now ?? Date.now)();
  }

  private async _removeTempOutput() {
    if (!this._tempOutputPath) return;
    await unlink(this._tempOutputPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}
