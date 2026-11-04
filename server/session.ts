import { LEASE_TTL_MS } from "../shared/rpc";
import { Bridge, type BridgeAction, type OpenFileMessage } from "./bridge";
import { randomBytes } from "node:crypto";

/*
 * What a VS Code server session has in common, local or in a dev container: a start that
 * reports progress and can be cancelled, leases held by Paseo tabs, and a stop once no tab
 * has used it for STOP_GRACE_MS.
 */

export type SessionStatus = "installing" | "starting" | "building" | "ready" | "error";

export interface OpenResult {
  status: SessionStatus | "choose";
  progress?: number;
  url?: string;
  message?: string;
}

type State =
  | { kind: "idle" }
  | { kind: "installing"; progress: number }
  | { kind: "starting"; message?: string }
  | { kind: "building"; message?: string }
  | { kind: "ready"; baseUrl: string }
  | { kind: "error"; message: string };

/** After the last lease goes, wait this long before stopping (a tab reopened at once). */
const STOP_GRACE_MS = 5_000;

export abstract class Session {
  protected state: State = { kind: "idle" };
  protected stopped = false;
  /** Bumped by every shutdown, so a start still in progress knows to give up. */
  protected generation = 0;
  /** Last start failure, reported once so the panel can show it instead of retrying forever. */
  private failure: string | null = null;
  /** Lives as long as the session object: file requests can arrive before VS Code is up. */
  readonly bridge = new Bridge(randomBytes(24).toString("hex"));
  /** Tabs keeping VS Code alive: "<client>\0<directory>" -> expiry time. */
  private leases = new Map<string, number>();
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;

  /** Set by the host: told each time the start moves on (see VSCodeHost). */
  onStatus: ((status: OpenResult) => void) | null = null;
  /** Set by the host: text for the start's log (Dev Containers terminal). */
  onLog: ((text: string) => void) | null = null;

  /**
   * Set by the host: runs what a VS Code window asks for, for the folder `directory`.
   * `origin`: the folder the window was opened on, when the action is for another one.
   */
  onAction: ((directory: string, action: BridgeAction, origin?: string) => Promise<void>) | null = null;

  constructor() {
    this.bridge.onAction = async (folder, action, origin) => {
      const directory = this.hostDirectory(folder);
      const from = origin ? this.hostDirectory(origin) : null;
      if (directory && this.onAction) await this.onAction(directory, action, from ?? undefined);
    };
  }

  /** The workspace folder on this machine for a folder as VS Code sees it. */
  protected abstract hostDirectory(folder: string): string | null;
  /** Starts code-server; must check `cancelled()` after each await. */
  protected abstract boot(cancelled: () => boolean): Promise<void>;
  /** Stops what boot() started. */
  protected abstract teardown(): Promise<void>;
  /** The folder as VS Code sees it (a container path for dev containers). */
  protected abstract vscodeFolder(directory: string): string;
  /** A host path as VS Code sees it. */
  protected abstract vscodePath(file: string): string;

  /** What the VS Code window of `directory` opens: its folder by default. */
  protected windowQuery(directory: string) {
    return `folder=${encodeURIComponent(this.vscodeFolder(directory))}`;
  }

  protected setProgress(kind: "installing" | "starting" | "building", detail?: number | string) {
    if (this.state.kind === "ready" || this.state.kind === "idle") return;
    if (kind === "installing") this.state = { kind, progress: typeof detail === "number" ? detail : 0 };
    else this.state = { kind, message: typeof detail === "string" ? detail : undefined };
    this.onStatus?.(kind === "installing" ? { status: kind, progress: (this.state as { progress: number }).progress } : { status: kind, message: typeof detail === "string" ? detail : undefined });
  }

  protected log(text: string) {
    this.onLog?.(text);
  }

  protected setReady(baseUrl: string) {
    this.state = { kind: "ready", baseUrl };
    this.onStatus?.({ status: "ready" });
  }

  isReady() {
    return this.state.kind === "ready";
  }

  /** Forgets a failed start, so the next open() tries again at once. */
  clearFailure() {
    this.failure = null;
  }

  /** code-server died on its own: the next open() starts it again. */
  protected crashed() {
    if (!this.stopped) this.state = { kind: "idle" };
  }

  /** Starts everything on first call; later calls report progress. Never throws. */
  open(directory: string): OpenResult {
    if (this.failure !== null) {
      const message = this.failure;
      this.failure = null;
      return { status: "error", message };
    }
    if (this.state.kind === "idle" || this.state.kind === "error") {
      this.state = { kind: "starting" };
      const generation = this.generation;
      const cancelled = () => this.stopped || generation !== this.generation;
      void this.boot(cancelled).catch((error) => {
        if (cancelled()) return;
        this.state = { kind: "error", message: error instanceof Error ? error.message : String(error) };
        this.failure = this.state.message;
        this.onStatus?.({ status: "error", message: this.state.message });
      });
    }
    switch (this.state.kind) {
      case "installing":
        return { status: "installing", progress: this.state.progress };
      case "building":
        return { status: "building", message: this.state.message };
      case "ready":
        return { status: "ready", url: `${this.state.baseUrl}?${this.windowQuery(directory)}` };
      case "starting":
        return { status: "starting", message: this.state.message };
      default:
        return { status: "starting" };
    }
  }

  /** Opens `file` in the VS Code window of `directory`, starting VS Code if needed. */
  openFile(directory: string, file: string, line?: number, endLine?: number): OpenResult {
    this.queueFile(directory, file, line, endLine);
    return this.open(directory);
  }

  /** Opens `file` in the VS Code window of `directory` once it is up, without starting it. */
  queueFile(directory: string, file: string, line?: number, endLine?: number) {
    const message: OpenFileMessage = { type: "open", path: this.vscodePath(file) };
    if (line) message.line = line;
    if (endLine) message.endLine = endLine;
    this.bridge.open(this.vscodeFolder(directory), message);
  }

  /** A tab of `client` shows (active) or no longer shows VS Code for `directory`. */
  lease(directory: string, client: string, active: boolean) {
    const key = `${client}\0${directory}`;
    if (active) this.leases.set(key, Date.now() + LEASE_TTL_MS);
    else this.leases.delete(key);
    if (!this.leaseTimer) this.leaseTimer = setInterval(() => this.checkLeases(), 10_000);
    this.checkLeases();
  }

  /** Every tab of `directory` moved to another session (mode switch). */
  releaseDirectory(directory: string) {
    for (const key of [...this.leases.keys()]) if (key.endsWith(`\0${directory}`)) this.leases.delete(key);
    this.checkLeases();
  }

  /** Stops VS Code once no tab has held a lease for STOP_GRACE_MS. */
  private checkLeases() {
    const now = Date.now();
    for (const [key, expiry] of this.leases) if (expiry < now) this.leases.delete(key);
    if (this.leases.size > 0) {
      if (this.stopTimer) clearTimeout(this.stopTimer);
      this.stopTimer = null;
      return;
    }
    if (this.stopTimer || this.state.kind === "idle") return;
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      if (this.leases.size === 0) void this.shutdown();
    }, STOP_GRACE_MS);
  }

  /** Stops code-server (and its extensions); the next open() starts it again. */
  async shutdown() {
    this.generation++;
    this.state = { kind: "idle" };
    await this.teardown();
  }

  /** The plugin stops. */
  async stop() {
    this.stopped = true;
    this.generation++;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.bridge.close();
    await this.teardown();
  }
}
