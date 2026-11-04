import { execCommand, spawnProcess } from "@getpaseo/plugin/server";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, SERVER_DIR } from "./install";

/*
 * The official dev container CLI (github.com/devcontainers/cli, MIT): it reads
 * devcontainer.json and builds and starts the container like VS Code does (image,
 * Dockerfile or Compose, features, lifecycle commands). It runs with the Node that ships
 * inside code-server. Pinned and verified against the npm registry's integrity hash.
 */

const CLI_VERSION = "0.90.0";
const CLI_INTEGRITY = "sha512-A4ceztBMlNzd1MUlQNel0dWxnkDlE83+WsgS4JOZfeBkbO0QUKEzBpd3UQ7Xqf7s0KzJaAj+Udnp4E8I3oqK3w==";
const CLI_DIR = path.join(DATA_DIR, "devcontainer-cli");
const CLI_JS = path.join(CLI_DIR, "package", "devcontainer.js");
const CLI_VERSION_FILE = path.join(CLI_DIR, ".paseo-version");
const NODE = path.join(SERVER_DIR, "lib", "node");

/** Where a workspace's dev container configuration is, if it has one. */
export function findDevContainerConfig(directory: string): string | null {
  for (const candidate of [path.join(directory, ".devcontainer", "devcontainer.json"), path.join(directory, ".devcontainer.json")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Strips JSONC comments and trailing commas (devcontainer.json), leaving strings alone. */
function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** devcontainer.json's "name", read without the CLI (fast); null if none or unreadable. */
export function devContainerName(directory: string): string | null {
  const file = findDevContainerConfig(directory);
  if (!file) return null;
  try {
    const name = JSON.parse(stripJsonc(readFileSync(file, "utf8"))).name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

export async function isCliInstalled(): Promise<boolean> {
  return existsSync(CLI_JS) && (await readFile(CLI_VERSION_FILE, "utf8").catch(() => "")).trim() === CLI_VERSION;
}

/** Downloads the dev container CLI if missing. The caller checks the user accepted it. */
export async function ensureCli(): Promise<void> {
  if (await isCliInstalled()) return;
  const url = `https://registry.npmjs.org/@devcontainers/cli/-/cli-${CLI_VERSION}.tgz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download the dev container CLI (${response.status}).`);
  const tarball = Buffer.from(await response.arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (integrity !== CLI_INTEGRITY) throw new Error("The downloaded dev container CLI does not match its published integrity hash.");
  const staging = `${CLI_DIR}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const archive = path.join(staging, "cli.tgz");
  await writeFile(archive, tarball);
  await execCommand("tar", ["xzf", archive, "-C", staging]);
  await rm(archive, { force: true });
  await writeFile(path.join(staging, ".paseo-version"), `${CLI_VERSION}\n`);
  await rm(CLI_DIR, { recursive: true, force: true });
  await rename(staging, CLI_DIR);
}

/** Docker must be installed and its daemon reachable by this user. */
export async function checkDocker(): Promise<void> {
  try {
    await execCommand("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 15_000 });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n").slice(-2).join(" ") : String(error);
    throw new Error(`Dev containers need Docker, and its daemon must be reachable by this user. ${detail}`);
  }
}

export interface DevContainerConfig {
  /** devcontainer.json's "name", if any. */
  name: string | null;
  extensions: string[];
  settings: Record<string, unknown>;
  shutdownAction: "none" | "stopContainer" | "stopCompose";
  compose: boolean;
}

function lastJson(stdout: string): any {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // not JSON
    }
  }
  throw new Error("The dev container CLI gave no result.");
}

/** devcontainer.json merged with what its features add (VS Code extensions and settings). */
export async function readConfig(directory: string): Promise<DevContainerConfig> {
  const { stdout } = await execCommand(NODE, [CLI_JS, "read-configuration", "--workspace-folder", directory, "--include-merged-configuration", "--log-format", "json"], {
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const result = lastJson(stdout);
  const merged = result.mergedConfiguration ?? result.configuration ?? {};
  const vscode: any[] = Array.isArray(merged.customizations?.vscode) ? merged.customizations.vscode : merged.customizations?.vscode ? [merged.customizations.vscode] : [];
  const extensions = [...new Set(vscode.flatMap((v) => (Array.isArray(v?.extensions) ? v.extensions : [])).filter((e: unknown): e is string => typeof e === "string"))];
  const settings = Object.assign({}, ...vscode.map((v) => (v?.settings && typeof v.settings === "object" ? v.settings : {})));
  const compose = !!(result.configuration?.dockerComposeFile ?? merged.dockerComposeFile);
  const action = result.configuration?.shutdownAction;
  const shutdownAction = action === "none" || action === "stopContainer" || action === "stopCompose" ? action : compose ? "stopCompose" : "stopContainer";
  const name = typeof merged.name === "string" && merged.name.trim() ? merged.name.trim() : typeof result.configuration?.name === "string" ? result.configuration.name : null;
  return { name, extensions, settings, shutdownAction, compose };
}

export interface UpResult {
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
}

/** Builds (if needed) and starts the dev container. Reports the CLI's log lines. */
export function up(
  directory: string,
  options: { rebuild?: boolean },
  onLog: (line: string, text: string) => void,
): Promise<UpResult> {
  // No id label of our own: the same container as VS Code's Dev Containers, found by its
  // workspace folder (or Compose service), reused when it already runs.
  const args = [CLI_JS, "up", "--workspace-folder", directory, "--log-format", "json"];
  if (options.rebuild) args.push("--remove-existing-container");
  return new Promise((resolve, reject) => {
    const child = spawnProcess(NODE, args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    // The CLI logs JSON lines on both streams: report their text, never raw JSON.
    const reporter = () => {
      let buffer = "";
      return (chunk: Buffer) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          let text = line;
          let full = line;
          try {
            const event = JSON.parse(line);
            if (event.outcome) continue; // the result, read at exit
            text = typeof event.text === "string" ? event.text : typeof event.name === "string" ? event.name : "";
            full = typeof event.text === "string" ? event.text : "";
          } catch {
            // a plain line
          }
          // Last line only, without terminal colors or carriage-return progress redraws.
          const last = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/).map((l) => l.split("\r").pop()?.trim() ?? "").filter(Boolean).pop();
          // Skip the CLI's own bookkeeping ("Run: docker ...", "Start: ...").
          // The terminal gets everything, colors included; the progress line skips the CLI's
          // own bookkeeping ("Run: docker ...", "Start: ...").
          const step = last && !/^(Run|Start|Stop)( in container)?:/.test(last) ? last.slice(0, 160) : "";
          if (step || full.trim()) onLog(step, full.replace(/\s+$/, ""));
        }
      };
    };
    const onStdout = reporter();
    const onStderr = reporter();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
      onStdout(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
      onStderr(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      try {
        const result = lastJson(stdout);
        if (result.outcome === "success" && result.containerId) {
          return resolve({ containerId: result.containerId, remoteUser: result.remoteUser ?? "root", remoteWorkspaceFolder: result.remoteWorkspaceFolder });
        }
        reject(new Error(result.message || result.description || `The dev container did not start (code ${code}).`));
      } catch {
        reject(new Error(`The dev container did not start (code ${code}).\n${stderr.slice(-1500)}`));
      }
    });
  });
}

/** Runs a command in the container as its remote user, with the dev container's environment. */
export function exec(directory: string, containerId: string, command: string[], remoteEnv: Record<string, string> = {}) {
  const args = [CLI_JS, "exec", "--workspace-folder", directory, "--container-id", containerId];
  for (const [k, v] of Object.entries(remoteEnv)) args.push("--remote-env", `${k}=${v}`);
  return spawnProcess(NODE, [...args, "--", ...command], { stdio: "pipe", detached: true });
}

/** Waits for a short command run with exec(); rejects with its output on failure. */
export function execAndWait(directory: string, containerId: string, command: string[], timeoutMs = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = exec(directory, containerId, command);
    let output = "";
    child.stdout.on("data", (c: Buffer) => (output += c));
    child.stderr.on("data", (c: Buffer) => (output += c));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out: ${command.join(" ")}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(output.trim().split("\n").slice(-3).join(" ") || `exit ${code}`));
    });
  });
}

/** Whether the workspace's dev container already runs (started by VS Code, Compose...). */
export async function isRunning(directory: string): Promise<boolean> {
  const { stdout } = await docker(["ps", "-q", "--filter", `label=devcontainer.local_folder=${directory}`]).catch(() => ({ stdout: "" }));
  return stdout.trim().length > 0;
}

export async function docker(args: string[], timeoutMs = 60_000) {
  return execCommand("docker", args, { timeout: timeoutMs });
}
