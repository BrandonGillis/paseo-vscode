import type { ChildProcess } from "node:child_process";

/*
 * bin/code-server is a shell script that starts Node, which starts more Node processes
 * (extension host, terminals, language servers). Killing the script would orphan them, so
 * VS Code runs in its own process group and the whole group is stopped.
 */
export function killGroup(pgid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false; // already gone
  }
}

export async function stopGroup(pgid: number) {
  if (!killGroup(pgid, "SIGTERM")) return;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!killGroup(pgid, 0 as unknown as NodeJS.Signals)) return;
  }
  killGroup(pgid, "SIGKILL");
}

const START_TIMEOUT_MS = 60_000;

/** Resolves once code-server says it listens; rejects if it exits or takes too long. */
export function waitForListening(child: ChildProcess, timeoutMs = START_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`VS Code did not start within ${timeoutMs / 1000}s.\n${output.slice(-2000)}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("HTTP server listening on")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`VS Code exited (code ${code}).\n${output.slice(-2000)}`));
    });
  });
}
