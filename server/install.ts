import { execCommand } from "@getpaseo/plugin/server";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Pinned so every install runs the same VS Code. Bump deliberately.
// code-server 4.144.0 is VS Code 1.144.0.
export const CODE_SERVER_VERSION = "4.144.0";

/** Where code-server, its data and its extensions live, outside the plugin checkout. */
export const DATA_DIR = path.join(process.env.PASEO_HOME || path.join(os.homedir(), ".paseo"), "plugin-data", "paseo-vscode");
export const SERVER_DIR = path.join(DATA_DIR, "code-server");
export const SERVER_BIN = path.join(SERVER_DIR, "bin", "code-server");
/** VS Code's built-in extensions inside code-server (where Paseo Bridge is installed). */
export const BUILTIN_EXTENSIONS_DIR = path.join(SERVER_DIR, "lib", "vscode", "extensions");
const VERSION_FILE = path.join(SERVER_DIR, ".paseo-version");

// code-server release assets: Linux and macOS, x64 and arm64.
function assetName(): string {
  const os_ = { linux: "linux", darwin: "macos" }[process.platform as string];
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch as string];
  if (!os_ || !arch) {
    throw new Error(`No code-server build for ${process.platform}-${process.arch} (Linux and macOS on x64 or arm64 are supported).`);
  }
  return `code-server-${CODE_SERVER_VERSION}-${os_}-${arch}`;
}

export async function isInstalled(): Promise<boolean> {
  if (!existsSync(SERVER_BIN)) return false;
  try {
    return (await readFile(VERSION_FILE, "utf8")).trim() === CODE_SERVER_VERSION;
  } catch {
    return false;
  }
}

/** Downloads and unpacks code-server. Reports progress from 0 to 1. */
export async function install(onProgress: (fraction: number) => void): Promise<void> {
  const name = assetName();
  const url = `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/${name}.tar.gz`;
  await mkdir(DATA_DIR, { recursive: true });
  const archive = path.join(DATA_DIR, `${name}.tar.gz.part`);
  const staging = path.join(DATA_DIR, "code-server.staging");

  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) from ${url}`);
  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  const body = Readable.fromWeb(response.body as any);
  body.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (total) onProgress(Math.min(received / total, 0.99));
  });
  await pipeline(body, createWriteStream(archive));

  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await execCommand("tar", ["xzf", archive, "-C", staging, "--strip-components=1"]);
  } catch (error) {
    throw new Error(`Could not unpack code-server: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!existsSync(path.join(staging, "bin", "code-server"))) throw new Error("The code-server archive has an unexpected layout.");
  await writeFile(path.join(staging, ".paseo-version"), `${CODE_SERVER_VERSION}\n`);

  await rm(SERVER_DIR, { recursive: true, force: true });
  await rename(staging, SERVER_DIR);
  await rm(archive, { force: true });
  onProgress(1);
}
