import { spawn } from "child_process";

const AGENT_BROWSER_PATH = process.env.AGENT_BROWSER_PATH || "agent-browser";

// Serialize all CLI calls to prevent daemon startup race conditions.
// agent-browser uses a daemon process — if multiple CLI calls arrive
// concurrently before the daemon is up, they all try to start it and fail.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.then(
    () => {},
    () => {}
  );
  return p;
}

function spawnCommand(
  args: string[],
  options: { session?: string; timeout?: number }
): Promise<string> {
  const fullArgs = [...args];

  if (options.session) {
    fullArgs.push("--session", options.session);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(AGENT_BROWSER_PATH, fullArgs, {
      env: {
        ...process.env,
        ...(options.session && { AGENT_BROWSER_SESSION: options.session }),
      },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timeoutMs = options.timeout ?? 30_000;
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim() || "OK");
      } else {
        reject(
          new Error(
            `agent-browser exited with code ${code}: ${(stderr || stdout).trim()}`
          )
        );
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to execute agent-browser: ${err.message}`));
    });
  });
}

/**
 * Execute an agent-browser CLI command with positional args and optional flags.
 * Uses spawn (not shell exec) for safety. Commands are serialized to prevent
 * daemon startup race conditions.
 */
export function runCommand(
  args: string[],
  options: { session?: string; timeout?: number } = {}
): Promise<string> {
  return enqueue(() => spawnCommand(args, options));
}
