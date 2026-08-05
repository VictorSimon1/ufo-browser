import { homeCase } from "./shared.mjs";

export const videoRecordingCase = homeCase(`
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const videoPath = join(artifactDir, "real-screencast.webm");

  await page.screencast.start({
    path: videoPath,
    size: { width: 640, height: 480 },
    quality: 80,
  });
  await page.evaluate(() => {
    const marker = document.createElement("div");
    marker.id = "recording-motion";
    marker.style.cssText =
      "position:fixed;left:16px;top:16px;width:96px;height:32px;" +
      "display:grid;place-items:center;background:#2457ff;color:white;" +
      "font:700 12px system-ui;z-index:9999;";
    document.body.append(marker);
  });
  for (let frame = 1; frame <= 15; frame += 1) {
    await page.locator("#recording-motion").evaluate((marker, value) => {
      marker.textContent = "frame " + value;
      marker.style.transform = "translateX(" + value * 8 + "px)";
    }, frame);
  }
  await page.screencast.stop();

  const videoStat = await stat(videoPath);
  assert(videoStat.isFile(), "screencast creates a WebM file");
  assert(videoStat.size > 1000, "screencast WebM is non-empty");

  const { stdout } = await execFileAsync(
    process.env.EGO_BROWSER_FFPROBE_PATH || "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_name,codec_type,width,height:format=duration",
      "-of",
      "json",
      videoPath,
    ],
    { timeout: 10000 },
  );
  const probe = JSON.parse(stdout);
  const videoStream = probe.streams.find(
    (stream) => stream.codec_type === "video",
  );
  assert(videoStream, "ffprobe finds a video stream");
  assertEqual(videoStream.codec_name, "vp8", "screencast uses VP8");
  assertEqual(videoStream.width, 640, "screencast has the requested width");
  assertEqual(videoStream.height, 480, "screencast has the requested height");
  assertEqual(
    probe.streams.some((stream) => stream.codec_type === "audio"),
    false,
    "screencast is silent",
  );
  const duration = Number(probe.format?.duration);
  assert(duration >= 0.8, "screencast preserves a visible duration");
  assert(duration < 10, "screencast duration stays bounded");
`);
