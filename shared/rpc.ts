import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Software the plugin downloads, only once the user accepts it. */
export const DOWNLOADS = ["code-server", "devcontainer-cli"] as const;

/**
 * Starts VS Code for a folder (downloading it the first time) and reports where it is.
 * The client calls it again until "ready", "error" or "choose".
 *   installing  code-server is downloading (progress)
 *   building    the dev container is being built or started (message: its last log line)
 *   starting    code-server is starting
 *   choose      the workspace has a devcontainer.json and no mode yet (see setModeRpc)
 *   download    software to download first, once the user accepts (see approveDownloadsRpc)
 */
export const openRpc = defineRpc({
  name: "vscode.open",
  input: z.object({ directory: z.string().min(1) }),
  output: z.object({
    status: z.enum(["installing", "building", "starting", "choose", "download", "ready", "error"]),
    /** With "download": what to download. */
    downloads: z.array(z.enum(DOWNLOADS)).optional(),
    /** 0..1 while downloading. */
    progress: z.number().optional(),
    /** Capability URL of the VS Code window for this folder, when ready. */
    url: z.string().optional(),
    message: z.string().optional(),
    /** The workspace has a devcontainer.json. */
    devcontainer: z.boolean().optional(),
    /** How it opens, once chosen. */
    mode: z.enum(["local", "container"]).nullable().optional(),
    /** Folders the window asked to open in Paseo tabs of their own (in their dev container). */
    tabs: z.array(z.object({ relative: z.string(), name: z.string() })).optional(),
  }),
});

/**
 * Folder tabs opened so far: paths relative to the workspace, with their title
 * (devcontainer.json's name).
 */
export const folderTabsRpc = defineRpc({
  name: "vscode.folder-tabs",
  input: z.object({}),
  output: z.object({ folders: z.array(z.object({ relative: z.string(), name: z.string() })) }),
});

/** A folder tab shows its folder: in its dev container, without asking. */
export const openFolderTabRpc = defineRpc({
  name: "vscode.open-folder-tab",
  input: z.object({ directory: z.string().min(1) }),
  output: z.object({ devcontainer: z.boolean() }),
});

/**
 * The folder whose VS Code shows `path` for the workspace `directory`: a folder of the
 * workspace opened in its own dev container, or the workspace itself.
 */
export const targetRpc = defineRpc({
  name: "vscode.target",
  input: z.object({ directory: z.string().min(1), path: z.string().min(1) }),
  output: z.object({ directory: z.string() }),
});

/** Opens the workspace locally or in its dev container from now on (remembered). */
export const setModeRpc = defineRpc({
  name: "vscode.set-mode",
  input: z.object({ directory: z.string().min(1), mode: z.enum(["local", "container"]) }),
  output: z.object({ ok: z.boolean() }),
});

/** The user accepted these downloads: the next start may fetch them. */
export const approveDownloadsRpc = defineRpc({
  name: "vscode.approve-downloads",
  input: z.object({ downloads: z.array(z.enum(DOWNLOADS)) }),
  output: z.object({ ok: z.boolean() }),
});

/** Removes the workspace's dev container so the next start builds it again. */
export const rebuildRpc = defineRpc({
  name: "vscode.rebuild",
  input: z.object({ directory: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
});

const openOutput = openRpc.output;

/** Opens a file (at a line) in the workspace's VS Code window, starting VS Code if needed. */
export const openFileRpc = defineRpc({
  name: "vscode.open-file",
  input: z.object({
    directory: z.string().min(1),
    path: z.string().min(1),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
  }),
  output: openOutput,
});


/**
 * A Paseo client keeps VS Code alive while one of its tabs shows it: renewed every
 * LEASE_RENEW_MS, released when the last tab closes. Without leases, VS Code is stopped.
 */
export const leaseRpc = defineRpc({
  name: "vscode.lease",
  input: z.object({ directory: z.string().min(1), client: z.string().min(1).max(100), active: z.boolean() }),
  output: z.object({ ok: z.boolean() }),
});
export const LEASE_RENEW_MS = 20_000;
export const LEASE_TTL_MS = 60_000;
