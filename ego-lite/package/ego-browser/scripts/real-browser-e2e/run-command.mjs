import { spawn } from "node:child_process";

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const echo = options.echo !== false;
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: process.env,
      stdio: options.input ? ["pipe", "pipe", "pipe"] : "inherit",
    });
    const timer =
      options.timeoutMs &&
      setTimeout(() => {
        settled = true;
        child.kill("SIGINT");
        reject(
          new Error(
            `${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`,
          ),
        );
      }, options.timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error.code === "ENOENT" && command === "ego-browser") {
        reject(
          new Error(
            "ego-browser command not found; install/open ego lite before running real browser e2e",
          ),
        );
        return;
      }
      reject(error);
    });
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (echo) process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      if (echo) process.stderr.write(chunk);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (
        /unknown option.*sdk-path|unrecognized option.*sdk-path/i.test(
          stdout + stderr,
        )
      ) {
        const error = new Error(
          `ego-browser nodejs --sdk-path is not supported; cannot verify SDK path ${options.egoBrowserSdkPath || "configured SDK path"}`,
        );
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      if (code === 0) {
        if (
          /ego's nodejs process exited with code\s+[1-9]\d*/.test(
            stdout + stderr,
          )
        ) {
          const error = new Error(
            `ego-browser nodejs reported an inner failure while exiting 0`,
          );
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      } else {
        const error = new Error(
          `${command} ${args.join(" ")} exited with code ${code}`,
        );
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
    if (options.input) {
      child.stdin.end(options.input);
    }
  });
}
