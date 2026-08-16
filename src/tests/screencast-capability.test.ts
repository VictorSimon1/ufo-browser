import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { helperContext } from "../agent/runtime/helpers.js";
import * as screencast from "../agent/runtime/driver/screencast.js";
import { ffmpegAvailability } from "../agent/runtime/video-recorder.js";

test("ffmpeg capability reports an invalid configured executable", async () => {
  const availability = await ffmpegAvailability(
    join(tmpdir(), `ufo-browser-missing-ffmpeg-${process.pid}`),
  );
  assert.equal(availability.available, false);
  assert.match(availability.reason || "", /not executable/i);
});

test("ffmpeg capability accepts an executable path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ufo-browser-ffmpeg-"));
  const executable = join(directory, "ffmpeg");
  try {
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    const availability = await ffmpegAvailability(executable);
    assert.deepEqual(availability, {
      available: true,
      path: executable,
      source: "option",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("page screencast exposes an agent-friendly capability check", async () => {
  const restore = screencast.__testing.setOverrides({
    ffmpegAvailability: async () => ({
      available: false,
      reason: "test encoder unavailable",
    }),
  });
  try {
    const context = helperContext();
    assert.equal(await context.page.screencast.isAvailable(), false);
    assert.deepEqual(await context.page.screencast.availability(), {
      available: false,
      reason: "test encoder unavailable",
    });
    await assert.rejects(
      context.page.screencast.start({ path: "/tmp/test.webm" }),
      /test encoder unavailable.*isAvailable/i,
    );
    assert.match(context.help("page"), /All page timeout values are milliseconds/);
    assert.match(context.help("timeouts"), /flat Ego-compatible helpers.*seconds/i);
    assert.match(context.help("click"), /options\.timeout is seconds/);
    assert.match(context.help("storageState"), /Captures all cookies/);
    assert.match(context.help("sendCDPMessage"), /JSON\.stringify/);
    assert.doesNotMatch(context.help("click"), /Unknown helper/);
  } finally {
    restore();
  }
});
