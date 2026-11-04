import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BridgeAction } from "./bridge";
import { ContainerSession } from "./container-session";
import { devContainerName, findDevContainerConfig } from "./devcontainer";
import { missingDownloads, unapproved, type Download } from "./downloads";
import { DATA_DIR } from "./install";
import { LocalSession } from "./local-session";
import type { OpenResult, Session } from "./session";

export type { OpenResult } from "./session";

const inside = (file: string, folder: string) => {
  const rel = path.relative(folder, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
export type WorkspaceMode = "local" | "container";

/** What a VS Code tab shows: the session's progress, or a question for the user. */
export type HostOpenResult = (OpenResult | { status: "download"; downloads: Download[] }) & {
  devcontainer: boolean;
  mode: WorkspaceMode | null;
};

const MODES_FILE = path.join(DATA_DIR, "workspaces.json");
/** Folders opened in a Paseo tab of their own: their tabs come back after a restart. */
const FOLDER_TABS_FILE = path.join(DATA_DIR, "folder-tabs.json");

/**
 * A folder tab, relative to the workspace: "src/api" is the api folder of whichever
 * workspace (worktree) the tab is in, so each worktree gets its own dev container.
 */
export interface FolderTab {
  relative: string;
  /** devcontainer.json's name when the tab was opened, else the folder's name: its title. */
  name: string;
}

/**
 * Picks the VS Code session of each workspace: the shared local one, or the workspace's own
 * dev container. A workspace with a devcontainer.json asks once which one to use; the
 * answer is remembered per folder.
 *
 * Like VS Code, a dev container starts from a local window: while it builds, the workspace
 * shows the local VS Code of the folder, which shows the progress and the log (Paseo
 * Bridge); once it is up, the tabs move to the container's VS Code. A failed start stays in
 * the local window, with Retry and Reopen Folder Locally.
 */
export class VSCodeHost {
  private readonly local: LocalSession;
  private readonly containers = new Map<string, ContainerSession>();
  private modes: Record<string, WorkspaceMode>;
  /** File links that arrived while the workspace still had to choose. */
  private pendingFiles = new Map<string, Parameters<Session["openFile"]>>();
  /** Folders whose dev container failed to start: they stay local until Retry. */
  private failed = new Map<string, string>();
  /**
   * Folders to open in a Paseo tab of their own, per workspace that asked (a multi-root
   * window's "Open Folder in Container..."). Handed to that workspace's tabs on their next poll.
   */
  private tabRequests = new Map<string, FolderTab[]>();
  private folderTabs: FolderTab[];

  /** `extensions` reads the plugin setting: extensions to install when VS Code starts. */
  constructor(private readonly extensions: () => Promise<readonly string[]> = async () => []) {
    this.local = new LocalSession(extensions);
    this.local.onAction = (directory, action, origin) => this.runAction(directory, action, origin);
    try {
      this.modes = JSON.parse(readFileSync(MODES_FILE, "utf8"));
    } catch {
      this.modes = {};
    }
    try {
      const list = JSON.parse(readFileSync(FOLDER_TABS_FILE, "utf8"));
      this.folderTabs = Array.isArray(list)
        ? list.filter((f): f is FolderTab => typeof f?.relative === "string" && typeof f?.name === "string")
        : [];
    } catch {
      this.folderTabs = [];
    }
  }

  private async saveModes() {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(MODES_FILE, JSON.stringify(this.modes, null, 2));
  }

  /** The session for `directory`, or null while the user has not chosen. */
  private sessionFor(directory: string): Session | null {
    const hasConfig = !!findDevContainerConfig(directory);
    const mode = this.modes[directory] ?? (hasConfig ? null : "local");
    if (mode === null) return null;
    if (mode === "local" || !hasConfig) return this.local;
    let session = this.containers.get(directory);
    if (!session) {
      session = new ContainerSession(directory, this.extensions);
      session.onAction = (dir, action) => this.runAction(dir, action);
      // The start, shown by the folder's local window.
      session.onStatus = (status) => {
        if (status.status === "choose") return;
        if (status.status === "error") this.failed.set(directory, status.message ?? "");
        this.local.bridge.containerStatus(directory, { type: "container", state: status.status, message: status.message });
        // The tabs move to the container on their next poll; the local window can go.
        if (status.status === "ready") setTimeout(() => this.local.releaseDirectory(directory), 3_000);
      };
      session.onLog = (text) => this.local.bridge.containerLog(directory, text);
      this.containers.set(directory, session);
    }
    return session;
  }

  /** What the panel shows: whether the workspace has a dev container and which mode it uses. */
  workspaceInfo(directory: string) {
    return { devcontainer: !!findDevContainerConfig(directory), mode: this.modes[directory] ?? null };
  }

  async open(directory: string): Promise<HostOpenResult & { tabs?: FolderTab[] }> {
    const requested = this.tabRequests.get(directory);
    this.tabRequests.delete(directory);
    const result = await this.openSession(directory);
    return requested?.length ? { ...result, tabs: requested } : result;
  }

  /** The folder tabs opened so far, in any workspace. */
  listFolderTabs(): FolderTab[] {
    return this.folderTabs;
  }

  /** A folder tab opens its folder in the dev container without asking. */
  async openFolderTab(directory: string) {
    if (findDevContainerConfig(directory) && !this.modes[directory]) await this.setMode(directory, "container");
  }

  private async openSession(directory: string): Promise<HostOpenResult> {
    const info = this.workspaceInfo(directory);
    const session = this.sessionFor(directory);
    if (!session) return { status: "choose", ...info };
    // Nothing is downloaded before the user accepts it (see downloads.ts).
    const downloads = unapproved(await missingDownloads(session instanceof ContainerSession));
    if (downloads.length) return { status: "download", downloads, ...info };
    if (session instanceof ContainerSession) {
      if (!this.failed.has(directory)) {
        const result = session.open(directory);
        if (result.status === "ready") return { ...result, ...info };
        if (result.status === "error") this.failed.set(directory, result.message ?? "");
      }
      // Starting, or failed: the local window of the folder shows how it goes. The tabs ask
      // every second or so, which keeps it alive until the container is up.
      this.local.lease(directory, "dev-container-start", true);
      return { ...this.local.open(directory), ...info };
    }
    return { ...session.open(directory), ...info };
  }

  /**
   * Which folder's VS Code shows `file` for the workspace `directory`: the innermost folder
   * holding it that opens in its own dev container (see "open-folder-in-container"), else
   * the workspace itself.
   */
  targetFor(directory: string, file: string): string {
    const folders = Object.entries(this.modes)
      .filter(([folder, mode]) => mode === "container" && folder !== directory && inside(file, folder) && findDevContainerConfig(folder))
      .map(([folder]) => folder)
      .sort((a, b) => b.length - a.length);
    return folders[0] ?? directory;
  }

  openFile(directory: string, file: string, line?: number, endLine?: number) {
    const session = this.sessionFor(directory);
    if (!session) this.pendingFiles.set(directory, [directory, file, line, endLine]);
    // Shown once VS Code is up; open() starts it, or asks first.
    else session.queueFile(directory, file, line, endLine);
    return this.open(directory);
  }

  lease(directory: string, client: string, active: boolean) {
    const session = this.sessionFor(directory);
    session?.lease(directory, client, active);
    // The local window stands in while the dev container starts (or after it failed).
    if (session instanceof ContainerSession && active && !session.isReady()) this.local.lease(directory, client, true);
    else if (session !== this.local) this.local.lease(directory, client, false);
  }

  /** Remembers how `directory` opens; tabs reload into the new session. */
  async setMode(directory: string, mode: WorkspaceMode) {
    this.failed.delete(directory);
    this.local.bridge.containerReset(directory);
    const before = this.sessionFor(directory);
    this.modes[directory] = mode;
    await this.saveModes();
    const after = this.sessionFor(directory);
    // The local window stays while a dev container starts: it shows the progress.
    if (before && before !== after && before !== this.local) before.releaseDirectory(directory);
    const pending = this.pendingFiles.get(directory);
    if (pending && after) {
      this.pendingFiles.delete(directory);
      after.queueFile(...pending);
    }
  }

  /** An action chosen in VS Code (status bar or command palette). */
  private async runAction(directory: string, action: BridgeAction, origin?: string) {
    if (action === "open-folder-in-container") {
      if (!findDevContainerConfig(directory)) return;
      await this.setMode(directory, "container");
      const from = origin ?? directory;
      if (from === directory) return;
      const tab: FolderTab = { relative: path.relative(from, directory), name: devContainerName(directory) ?? path.basename(directory) };
      const known = this.folderTabs.find((t) => t.relative === tab.relative);
      if (known?.name !== tab.name) {
        this.folderTabs = [...this.folderTabs.filter((t) => t.relative !== tab.relative), tab];
        await mkdir(DATA_DIR, { recursive: true });
        await writeFile(FOLDER_TABS_FILE, JSON.stringify(this.folderTabs, null, 2));
      }
      this.tabRequests.set(from, [...(this.tabRequests.get(from) ?? []).filter((t) => t.relative !== tab.relative), tab]);
      return;
    }
    if (action === "rebuild-container") return this.rebuild(directory);
    if (action === "rebuild-and-reopen-in-container") {
      if (!findDevContainerConfig(directory)) return;
      // The container's next start removes it first (a start already begun is cancelled);
      // the local window shows the progress.
      await this.setMode(directory, "container");
      await this.rebuild(directory);
      return;
    }
    if (action === "retry-container") {
      this.failed.delete(directory);
      this.local.bridge.containerReset(directory);
      this.containers.get(directory)?.clearFailure();
      return;
    }
    const mode: WorkspaceMode = action === "reopen-locally" ? "local" : "container";
    if (mode === "container" && !findDevContainerConfig(directory)) return;
    await this.setMode(directory, mode);
  }

  /** Removes the workspace's dev container; the next open builds it again. */
  async rebuild(directory: string) {
    const session = this.sessionFor(directory);
    if (session instanceof ContainerSession) {
      this.failed.delete(directory);
      this.local.bridge.containerReset(directory);
      await session.rebuild();
    }
  }

  /** Installs configured extensions that are missing (setting changed while running). */
  async syncExtensions() {
    await this.local.syncExtensions();
  }

  async stop() {
    await Promise.all([this.local.stop(), ...[...this.containers.values()].map((s) => s.stop())]);
  }
}
