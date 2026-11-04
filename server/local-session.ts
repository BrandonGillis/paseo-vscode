import { spawnProcess } from "@getpaseo/plugin/server";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BRIDGE_PATH } from "./bridge";
import { installBridgeExtension } from "./bridge-extension";
import { assertApproved } from "./downloads";
import { CONFIG_FILE, ensureExtensions, EXTENSIONS_DIR, SERVER_DATA_DIR } from "./extensions";
import { BUILTIN_EXTENSIONS_DIR, DATA_DIR, install, isInstalled, SERVER_BIN } from "./install";
import { killGroup, stopGroup, waitForListening } from "./processes";
import { startProxy, type Proxy } from "./proxy";
import { Session } from "./session";
import { installThemeExtension, updateTheme } from "./theme-extension";

const PID_FILE = path.join(DATA_DIR, "server.pid");

/** A server left behind by a daemon that crashed before cleaning up. */
async function stopStaleServer() {
  let pgid: number;
  try {
    pgid = Number((await readFile(PID_FILE, "utf8")).trim());
  } catch {
    return;
  }
  if (Number.isInteger(pgid) && pgid > 1) {
    // Only if that group is still ours: its leader runs our VS Code build.
    const cmdline = await readFile(`/proc/${pgid}/cmdline`, "utf8").catch(() => "");
    if (cmdline.includes(SERVER_BIN) || cmdline.includes(path.dirname(path.dirname(SERVER_BIN)))) await stopGroup(pgid);
  }
  await rm(PID_FILE, { force: true });
}

/** The folder's only `*.code-workspace` file, if it has exactly one. */
export function findWorkspaceFile(directory: string): string | null {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".code-workspace"));
  } catch {
    return null;
  }
  return names.length === 1 ? path.join(directory, names[0]) : null;
}

/** Makes sure code-server is downloaded (progress through `onProgress`). */
export async function ensureCodeServer(onProgress: (fraction: number) => void) {
  if (!(await isInstalled())) {
    assertApproved("code-server");
    await install(onProgress);
  }
  await installBridgeExtension(BUILTIN_EXTENSIONS_DIR);
  await installThemeExtension(BUILTIN_EXTENSIONS_DIR);
}

/** One local code-server for every workspace opened outside a dev container. */
export class LocalSession extends Session {
  private child: ChildProcessWithoutNullStreams | null = null;
  private proxy: Proxy | null = null;

  constructor(private readonly extensions: () => Promise<readonly string[]>) {
    super();
  }

  protected hostDirectory(folder: string) {
    return folder;
  }

  protected vscodeFolder(directory: string) {
    return directory;
  }

  protected vscodePath(file: string) {
    return file;
  }

  /**
   * A folder holding exactly one `.code-workspace` file opens that workspace (multi-root:
   * front, back, infra...), like `code my.code-workspace`; otherwise the folder itself.
   */
  protected windowQuery(directory: string) {
    const file = findWorkspaceFile(directory);
    return file ? `workspace=${encodeURIComponent(file)}` : super.windowQuery(directory);
  }

  /** Installs configured extensions that are missing (setting changed while running). */
  async syncExtensions() {
    const failures = await ensureExtensions(await this.extensions());
    for (const f of failures) console.warn(`[paseo-vscode] Could not install ${f}`);
  }

  protected async boot(cancelled: () => boolean) {
    await ensureCodeServer((progress) => this.setProgress("installing", progress));
    if (cancelled()) return;
    this.setProgress("starting");

    const secret = randomBytes(24).toString("hex");
    await mkdir(SERVER_DATA_DIR, { recursive: true });
    await mkdir(EXTENSIONS_DIR, { recursive: true });
    // Before VS Code starts, so they load in its first window.
    await this.syncExtensions();
    await stopStaleServer();

    // A Unix socket only this user can open is code-server's access control (see proxy.ts).
    // In XDG_RUNTIME_DIR when there is one: private, and short enough for a socket path.
    const runtimeDir = process.env.XDG_RUNTIME_DIR && process.env.XDG_RUNTIME_DIR.length < 60 ? process.env.XDG_RUNTIME_DIR : DATA_DIR;
    const socketPath = path.join(runtimeDir, `paseo-vscode-${process.getuid?.() ?? os.userInfo().uid}.sock`);
    await rm(socketPath, { force: true });

    let upstream: string | null = null;
    const portFile = path.join(DATA_DIR, "proxy-port");
    const preferredPort = Number((await readFile(portFile, "utf8").catch(() => "")).trim()) || undefined;
    const proxy = await startProxy({
      preferredPort,
      secret,
      upstreamSocket: () => upstream,
      bridge: this.bridge,
      onAppearance: (appearance) => updateTheme(BUILTIN_EXTENSIONS_DIR, appearance),
    });
    this.proxy = proxy;
    if (proxy.port !== preferredPort) await writeFile(portFile, `${proxy.port}\n`);
    const child = spawnProcess(
      SERVER_BIN,
      [
        // Its own config file (written by ensureExtensions), so code-server never touches
        // ~/.config/code-server/config.yaml.
        "--config", CONFIG_FILE,
        "--socket", socketPath,
        "--socket-mode", "600",
        "--auth", "none",
        "--user-data-dir", SERVER_DATA_DIR,
        "--extensions-dir", EXTENSIONS_DIR,
        "--disable-telemetry",
        "--disable-update-check",
        "--disable-workspace-trust",
        "--disable-getting-started-override",
      ],
      {
        stdio: "pipe",
        detached: true,
        env: {
          ...process.env,
          // Read by the Paseo Bridge extension in each window's extension host.
          PASEO_BRIDGE_URL: `http://127.0.0.1:${proxy.port}${BRIDGE_PATH}`,
          PASEO_BRIDGE_TOKEN: this.bridge.token,
          PASEO_MODE: "local",
        },
      },
    );
    if (cancelled()) {
      // Every tab closed while VS Code was starting.
      proxy.close();
      if (child.pid) await stopGroup(child.pid);
      return;
    }
    this.child = child;
    if (child.pid) await writeFile(PID_FILE, `${child.pid}\n`);

    await waitForListening(child);
    if (cancelled()) return; // teardown() stops the child it now owns
    upstream = socketPath;
    this.setReady(`http://127.0.0.1:${proxy.port}/${secret}/`);

    child.once("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      if (child.pid) killGroup(child.pid, "SIGTERM"); // its helpers may outlive the script
      this.proxy?.close();
      this.proxy = null;
      this.crashed();
    });
  }

  protected async teardown() {
    this.proxy?.close();
    this.proxy = null;
    const child = this.child;
    this.child = null;
    if (child?.pid) {
      await stopGroup(child.pid);
      await rm(PID_FILE, { force: true });
      console.log("[paseo-vscode] VS Code stopped.");
    }
  }
}
