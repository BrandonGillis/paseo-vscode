import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { assertApproved } from "./downloads";
import { checkDocker, docker, ensureCli, exec, execAndWait, isCliInstalled, isRunning, readConfig, up, type DevContainerConfig, type UpResult } from "./devcontainer";
import { BUILTIN_EXTENSIONS_DIR, CODE_SERVER_VERSION, DATA_DIR, SERVER_DIR } from "./install";
import { ensureCodeServer } from "./local-session";
import { stopGroup, waitForListening } from "./processes";
import { startProxy, type Proxy } from "./proxy";
import { startRelay, type Relay } from "./relay";
import { Session } from "./session";
import { updateTheme } from "./theme-extension";

/*
 * A workspace opened in its dev container: code-server runs inside the container, so the
 * terminal, tasks, debugger, language servers and extensions run there too.
 *
 * It is the container VS Code's Dev Containers uses (same labels): reused when it already
 * runs, whether it comes from an image, a Dockerfile or a Compose service. Nothing is
 * mounted and the container is never recreated for the plugin (except "Rebuild").
 *
 * Inside the container, under /opt/paseo (created as root, like ~/.vscode-server):
 *   code-server/  a copy of the plugin's code-server build with Paseo Bridge and Paseo
 *                 Theme, made with docker cp; owned by root.
 *   data/         extensions and VS Code data of the remote user.
 *   run/          code-server's socket and Paseo Bridge's socket (mode 700, remote user).
 * The plugin reaches both sockets through one docker exec (see relay.ts). Nothing listens
 * on a network port.
 */

const IN = {
  root: "/opt/paseo",
  codeServer: "/opt/paseo/code-server",
  run: "/opt/paseo/run",
  data: "/opt/paseo/data",
};
const IN_NODE = `${IN.codeServer}/lib/node`;

// Kills code-server and what it started inside the container (no pkill in slim images),
// not the relay of a running session.
const KILL_CODE_SERVER = `for (const p of require("fs").readdirSync("/proc")) { if (!/^\\d+$/.test(p) || +p === process.pid) continue; try { const c = require("fs").readFileSync("/proc/" + p + "/cmdline", "utf8"); if (c.includes("${IN.codeServer}/") && !c.includes("process.stdin")) process.kill(+p, "SIGTERM"); } catch {} }`;

// Run as root: creates /opt/paseo and gives the remote user ($1) its data and run folders.
const PREPARE = `mkdir -p ${IN.codeServer} ${IN.data}/extensions ${IN.data}/user-data ${IN.run} && chown "$1" ${IN.data} ${IN.data}/extensions ${IN.data}/user-data ${IN.run} && chmod 700 ${IN.run} && printf 'auth: none\\ncert: false\\n' > ${IN.run}/code-server.yaml && chown "$1" ${IN.run}/code-server.yaml && rm -f ${IN.run}/cs.sock`;

export class ContainerSession extends Session {
  private readonly key: string;
  private readonly runDir: string;
  private container: UpResult | null = null;
  private config: DevContainerConfig | null = null;
  /** False when the container already ran: then stopping VS Code leaves it running. */
  private startedContainer = false;
  private child: ChildProcessWithoutNullStreams | null = null;
  private proxy: Proxy | null = null;
  private relay: Relay | null = null;
  private bridgeServer: http.Server | null = null;
  private rebuildNext = false;

  constructor(
    readonly directory: string,
    private readonly extensions: () => Promise<readonly string[]>,
  ) {
    super();
    this.key = createHash("sha256").update(directory).digest("hex").slice(0, 12);
    this.runDir = path.join(DATA_DIR, "containers", this.key);
  }

  /** The next start removes the container and builds it again. */
  async rebuild() {
    this.rebuildNext = true;
    await this.shutdown();
  }

  protected hostDirectory() {
    return this.directory;
  }

  protected vscodeFolder() {
    return this.container?.remoteWorkspaceFolder ?? this.directory;
  }

  /** Host paths in the workspace become container paths. */
  protected vscodePath(file: string) {
    const remote = this.container?.remoteWorkspaceFolder;
    if (!remote) return file;
    const rel = path.relative(this.directory, file);
    return rel.startsWith("..") || path.isAbsolute(rel) ? file : path.posix.join(remote, rel.split(path.sep).join("/"));
  }

  protected async boot(cancelled: () => boolean) {
    await ensureCodeServer((progress) => this.setProgress("installing", progress));
    if (cancelled()) return;
    this.step("building", "Preparing the dev container…");
    if (!(await isCliInstalled())) {
      assertApproved("devcontainer-cli");
      await ensureCli();
    }
    await checkDocker();
    const config = await readConfig(this.directory);
    this.config = config;
    if (cancelled()) return;

    await mkdir(this.runDir, { recursive: true, mode: 0o700 });
    await chmod(this.runDir, 0o700);
    const rebuild = this.rebuildNext;
    this.rebuildNext = false;
    const wasRunning = !rebuild && (await isRunning(this.directory));
    const container = await up(this.directory, { rebuild }, (line, text) => {
      if (line) this.setProgress("building", line);
      if (text) this.log(text);
    });
    this.container = container;
    this.startedContainer = !wasRunning;
    const id = container.containerId;
    const user = container.remoteUser;
    if (cancelled()) return;

    // A code-server left running by a plugin that did not stop cleanly (crash, killed daemon).
    await docker(["exec", "-u", "root", id, "sh", "-c", `[ -x ${IN_NODE} ] && ${IN_NODE} -e '${KILL_CODE_SERVER}' || true`]).catch(() => {});
    await docker(["exec", "-u", "root", id, "sh", "-c", PREPARE, "sh", user]);
    await this.copyCodeServer(id);
    if (cancelled()) return;

    // Extensions from the plugin settings and from devcontainer.json, from Open VSX.
    const wanted = [...new Set([...(await this.extensions()), ...config.extensions])];
    for (const ext of wanted) {
      if (cancelled()) return;
      this.step("building", `Installing ${ext}…`);
      await execAndWait(this.directory, id, [
        `${IN.codeServer}/bin/code-server`, "--config", `${IN.run}/code-server.yaml`,
        "--extensions-dir", `${IN.data}/extensions`, "--user-data-dir", `${IN.data}/user-data`,
        "--install-extension", ext,
      ]).catch((error) => {
        const message = `Could not install ${ext} in the dev container: ${error instanceof Error ? error.message : error}`;
        console.warn(`[paseo-vscode] ${message}`);
        this.log(message);
      });
    }
    if (cancelled()) return;
    this.step("starting", "Starting VS Code in the container…");

    // Paseo Bridge, in the container, reaches this server through the relay.
    const bridgeSocket = path.join(this.runDir, "bridge.sock");
    await rm(bridgeSocket, { force: true });
    const bridgeServer = http.createServer((req, res) => {
      if (!this.bridge.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => bridgeServer.once("error", reject).listen(bridgeSocket, resolve));
    await chmod(bridgeSocket, 0o600);
    this.bridgeServer = bridgeServer;

    const csSocket = path.join(this.runDir, "cs.sock");
    const relay = await startRelay({
      containerId: id,
      user,
      node: IN_NODE,
      forward: { listen: csSocket, target: `${IN.run}/cs.sock` },
      reverse: { listen: `${IN.run}/bridge.sock`, target: bridgeSocket },
    });
    this.relay = relay;
    if (cancelled()) return;

    let upstream: string | null = null;
    const portFile = path.join(DATA_DIR, "containers", `${this.key}.port`);
    const preferredPort = Number((await readFile(portFile, "utf8").catch(() => "")).trim()) || undefined;
    const proxy = await startProxy({
      preferredPort,
      secret: randomBytes(24).toString("hex"),
      upstreamSocket: () => upstream,
      bridge: this.bridge,
      // The theme is written on the host, then copied into the container's code-server.
      onAppearance: async (appearance) => {
        await updateTheme(BUILTIN_EXTENSIONS_DIR, appearance);
        await this.copyBuiltins(id, ["paseo-theme"]);
      },
      // devcontainer.json's settings, below anything the user sets in VS Code.
      extraDefaults: () => config.settings,
      // VS Code's own remote indicator, as with its Dev Containers extension.
      windowIndicator: () => ({
        label: `$(remote) Dev Container: ${config.name ?? path.basename(this.directory)}`,
        tooltip: `Dev Container: ${config.name ?? path.basename(this.directory)}`,
      }),
    });
    this.proxy = proxy;
    if (proxy.port !== preferredPort) await writeFile(portFile, `${proxy.port}\n`);
    const secretUrl = proxy.baseUrl;

    const child = exec(
      this.directory,
      id,
      [
        `${IN.codeServer}/bin/code-server`,
        "--config", `${IN.run}/code-server.yaml`,
        "--socket", `${IN.run}/cs.sock`,
        "--socket-mode", "600",
        "--auth", "none",
        "--user-data-dir", `${IN.data}/user-data`,
        "--extensions-dir", `${IN.data}/extensions`,
        "--disable-telemetry",
        "--disable-update-check",
        "--disable-workspace-trust",
        "--disable-getting-started-override",
      ],
      { PASEO_BRIDGE_SOCKET: `${IN.run}/bridge.sock`, PASEO_BRIDGE_TOKEN: this.bridge.token, PASEO_MODE: "container" },
    ) as ChildProcessWithoutNullStreams;
    this.child = child;
    await waitForListening(child, 120_000);
    if (cancelled()) return;
    upstream = csSocket;
    this.setReady(secretUrl);

    const onStopped = () => {
      if (this.child !== child) return;
      this.child = null;
      this.closeServers();
      this.crashed();
    };
    child.once("exit", onStopped);
    relay.onExit(onStopped);
  }

  /** A step shown in the progress notification and written to the log. */
  private step(kind: "building" | "starting", message: string) {
    this.setProgress(kind, message);
    this.log(message);
  }

  /** Fills the code-server volume on first use of a version; refreshes Paseo's extensions. */
  private async copyCodeServer(containerId: string) {
    const marker = await docker(["exec", containerId, "cat", `${IN.codeServer}/.paseo-version`]).then((r) => r.stdout.trim()).catch(() => "");
    if (marker !== CODE_SERVER_VERSION) {
      this.step("building", "Copying VS Code into the dev container (first time only)…");
      await docker(["exec", "-u", "root", containerId, "rm", "-f", `${IN.codeServer}/.paseo-version`]);
      await docker(["cp", `${SERVER_DIR}/.`, `${containerId}:${IN.codeServer}/`], 600_000);
      // Written last: an interrupted copy is done again.
      await docker(["exec", "-u", "root", containerId, "sh", "-c", `echo ${CODE_SERVER_VERSION} > ${IN.codeServer}/.paseo-version`]);
    }
    await this.copyBuiltins(containerId, ["paseo-bridge", "paseo-theme"]);
  }

  private async copyBuiltins(containerId: string, names: string[]) {
    for (const name of names) {
      await docker(["cp", path.join(BUILTIN_EXTENSIONS_DIR, name), `${containerId}:${IN.codeServer}/lib/vscode/extensions/`]);
    }
  }

  private closeServers() {
    this.relay?.close();
    this.relay = null;
    this.proxy?.close();
    this.proxy = null;
    this.bridgeServer?.close();
    this.bridgeServer = null;
  }

  protected async teardown() {
    this.closeServers();
    const child = this.child;
    this.child = null;
    if (child?.pid) await stopGroup(child.pid);
    const container = this.container;
    if (!container) return;
    // Stop code-server inside (the exec client above does not take it down).
    await docker(["exec", "-u", "root", container.containerId, IN_NODE, "-e", KILL_CODE_SERVER]).catch(() => {});
    this.container = null;
    // A container that already ran (VS Code, docker compose up...) is left as it was.
    if (!this.startedContainer) {
      console.log(`[paseo-vscode] VS Code stopped in the dev container of ${this.directory}; the container keeps running.`);
      return;
    }
    // Otherwise the container stops as devcontainer.json's shutdownAction says.
    const action = this.config?.shutdownAction ?? "stopContainer";
    if (action === "stopContainer") {
      await docker(["stop", container.containerId], 120_000).catch(() => {});
    } else if (action === "stopCompose") {
      const project = await docker(["inspect", "--format", '{{index .Config.Labels "com.docker.compose.project"}}', container.containerId])
        .then((r) => r.stdout.trim())
        .catch(() => "");
      if (project) {
        const ids = (await docker(["ps", "-q", "--filter", `label=com.docker.compose.project=${project}`]).catch(() => ({ stdout: "" }))).stdout.split("\n").filter(Boolean);
        if (ids.length) await docker(["stop", ...ids], 180_000).catch(() => {});
      }
    }
    console.log(`[paseo-vscode] Dev container of ${this.directory} stopped (${action}).`);
  }
}
