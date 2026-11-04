import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/*
 * "Paseo Bridge": a tiny VS Code extension installed as a built-in of code-server.
 * It runs in each window's extension host, connects back to the plugin (a local URL, or a
 * Unix socket inside a dev container, and a token, from environment variables the plugin
 * sets when it starts VS Code), and opens the files Paseo asks for (file links in the chat).
 * In a workspace with a dev container it also adds, like VS Code's Dev Containers, commands
 * to reopen locally, in the container, or rebuild it, in the menu of VS Code's remote
 * indicator (bottom left) and in the command palette; Paseo
 * carries them out and reloads its tabs. Without these variables it does nothing.
 */

const VERSION = "0.10.0";

const MANIFEST = {
  name: "paseo-bridge",
  displayName: "Paseo Bridge",
  description: "Opens files from Paseo in this VS Code window.",
  publisher: "paseo",
  version: VERSION,
  engines: { vscode: "^1.80.0" },
  activationEvents: ["onStartupFinished"],
  main: "./extension.js",
  extensionKind: ["workspace"],
  contributes: {
    commands: [
      { command: "paseo.reopenInContainer", title: "Reopen in Container", category: "Dev Containers" },
      { command: "paseo.reopenLocally", title: "Reopen Folder Locally", category: "Dev Containers" },
      { command: "paseo.rebuildContainer", title: "Rebuild Container", category: "Dev Containers" },
      { command: "paseo.rebuildAndReopenInContainer", title: "Rebuild and Reopen in Container", category: "Dev Containers" },
      { command: "paseo.showContainerLog", title: "Show Container Log", category: "Dev Containers" },
      { command: "paseo.openFolderInContainer", title: "Open Folder in Container...", category: "Dev Containers" },
    ],
    menus: {
      commandPalette: [
        { command: "paseo.reopenInContainer", when: "paseo.mode == local && paseo.hasDevContainer" },
        { command: "paseo.reopenLocally", when: "paseo.mode == container" },
        { command: "paseo.rebuildContainer", when: "paseo.mode == container" },
        { command: "paseo.rebuildAndReopenInContainer", when: "paseo.mode == local && paseo.hasDevContainer" },
        { command: "paseo.showContainerLog", when: "paseo.containerStarting" },
        { command: "paseo.openFolderInContainer", when: "paseo.mode == local && paseo.hasFolderContainers" },
      ],
      // The menu of VS Code's remote indicator (bottom left), like the Dev Containers extension.
      "statusBar/remoteIndicator": [
        { command: "paseo.reopenInContainer", when: "paseo.mode == local && paseo.hasDevContainer", group: "remote_00_dev-containers_1general@1" },
        { command: "paseo.reopenLocally", when: "paseo.mode == container", group: "remote_00_dev-containers_1general@1" },
        { command: "paseo.rebuildContainer", when: "paseo.mode == container", group: "remote_00_dev-containers_1general@2" },
        { command: "paseo.rebuildAndReopenInContainer", when: "paseo.mode == local && paseo.hasDevContainer", group: "remote_00_dev-containers_1general@2" },
        { command: "paseo.openFolderInContainer", when: "paseo.mode == local && paseo.hasFolderContainers", group: "remote_00_dev-containers_1general@3" },
      ],
    },
  },
};

const EXTENSION_JS = String.raw`"use strict";
const vscode = require("vscode");
const http = require("http");

async function open(message) {
  const uri = vscode.Uri.file(message.path);
  const options = { preview: false, preserveFocus: false };
  if (message.line) {
    const start = new vscode.Position(Math.max(0, message.line - 1), 0);
    const end = message.endLine && message.endLine > message.line ? new vscode.Position(message.endLine - 1, Number.MAX_SAFE_INTEGER) : start;
    options.selection = new vscode.Range(start, end);
  }
  try {
    const editor = await vscode.window.showTextDocument(uri, options);
    if (options.selection) editor.revealRange(options.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch {
    // Not a text file (image, binary...): let VS Code pick its editor.
    await vscode.commands.executeCommand("vscode.open", uri);
  }
}

function activate(context) {
  const base = process.env.PASEO_BRIDGE_URL;
  const socketPath = process.env.PASEO_BRIDGE_SOCKET;
  const token = process.env.PASEO_BRIDGE_TOKEN;
  if ((!base && !socketPath) || !token) return;
  const mode = process.env.PASEO_MODE === "container" ? "container" : "local";
  let stopped = false;
  let request = null;
  context.subscriptions.push({ dispose() { stopped = true; if (request) request.destroy(); } });
  const fs = require("fs");
  const path = require("path");
  const folders = () => (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  // The folder Paseo opened this window on: the one holding the .code-workspace file of a
  // multi-root window, else the window's folder.
  const workspaceFile = vscode.workspace.workspaceFile;
  const origin = () => (mode === "local" && workspaceFile && workspaceFile.scheme === "file" ? path.dirname(workspaceFile.fsPath) : folders()[0] || "");
  const headers = { authorization: "Bearer " + token };
  const target = (route) => (socketPath ? { socketPath, path: "/__paseo_bridge/" + route } : new URL(base + "/" + route));

  // Dev containers: Paseo switches the workspace and reloads its tabs.
  function post(action, folder) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ action, folder: folder || origin(), origin: origin() });
      const options = { method: "POST", headers: { ...headers, "content-type": "application/json" } };
      const where = target("action");
      const onResponse = (res) => {
        res.resume();
        res.statusCode === 202 ? resolve() : reject(new Error("Paseo answered " + res.statusCode));
      };
      // A Unix socket takes one options object; a URL takes the URL, then the options.
      const req = socketPath ? http.request({ ...where, ...options }, onResponse) : http.request(where, options, onResponse);
      req.on("error", reject);
      req.end(body);
    });
  }
  async function run(action, message, folder) {
    try {
      await post(action, folder);
      vscode.window.setStatusBarMessage("$(sync~spin) " + message, 15000);
    } catch (error) {
      vscode.window.showErrorMessage("Paseo: " + (error && error.message ? error.message : error));
    }
  }
  const actions = {
    reopenInContainer: () => run("reopen-in-container", "Reopening in the dev container…"),
    reopenLocally: () => run("reopen-locally", "Reopening locally…"),
    async rebuildContainer() {
      if (await confirmRebuild()) await run("rebuild-container", "Rebuilding the dev container…");
    },
    async rebuildAndReopenInContainer() {
      if (await confirmRebuild()) await run("rebuild-and-reopen-in-container", "Rebuilding the dev container…");
    },
    // Another folder (a repo of a multi-root workspace, or a subfolder) in its own dev
    // container: Paseo opens it in a new tab; this window stays as it is.
    async openFolderInContainer(folder) {
      const choices = folderContainers();
      if (typeof folder !== "string" || !choices.includes(folder)) {
        if (!choices.length) return;
        if (choices.length === 1) folder = choices[0];
        else {
          const pick = await vscode.window.showQuickPick(
            choices.map((f) => ({ label: path.basename(f), description: f, folder: f })),
            { placeHolder: "Select a folder to open in its dev container (in a new Paseo tab)" },
          );
          if (!pick) return;
          folder = pick.folder;
        }
      }
      await run("open-folder-in-container", "Opening " + path.basename(folder) + " in its dev container…", folder);
    },
  };
  async function confirmRebuild() {
    const choice = await vscode.window.showWarningMessage(
      "Rebuild the dev container?",
      { modal: true, detail: "The container is removed and built again from devcontainer.json. Anything not stored in the workspace folder or in a volume is lost." },
      "Rebuild",
    );
    return choice === "Rebuild";
  }
  for (const [name, fn] of Object.entries(actions)) context.subscriptions.push(vscode.commands.registerCommand("paseo." + name, fn));

  // Which actions VS Code's remote indicator menu and the command palette offer.
  const hasConfig = (f) => fs.existsSync(path.join(f, ".devcontainer", "devcontainer.json")) || fs.existsSync(path.join(f, ".devcontainer.json"));
  const hasDevContainer = mode === "container" || (!!origin() && hasConfig(origin()));
  // Other folders with a dev container: the folders of a multi-root window, and the
  // subfolders of the window's folders (a folder holding front/, back/, infra/...).
  function folderContainers() {
    if (mode !== "local") return [];
    const found = new Set();
    for (const f of folders()) {
      found.add(f);
      let entries = [];
      try { entries = fs.readdirSync(f, { withFileTypes: true }); } catch {}
      for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") found.add(path.join(f, e.name));
    }
    found.delete(origin());
    return [...found].filter(hasConfig).sort();
  }
  const others = folderContainers();
  vscode.commands.executeCommand("setContext", "paseo.mode", mode);
  vscode.commands.executeCommand("setContext", "paseo.hasDevContainer", hasDevContainer);
  vscode.commands.executeCommand("setContext", "paseo.hasFolderContainers", others.length > 0);

  // Opened locally on a folder with a dev container: offer to reopen in it, like VS Code.
  const HIDE_FOLDER = "paseo.hideDevContainerNotice";
  const HIDE_ALL = "paseo.hideDevContainerNoticeEverywhere";
  if (mode === "local" && (hasDevContainer || others.length) && !context.workspaceState.get(HIDE_FOLDER) && !context.globalState.get(HIDE_ALL)) {
    // A dev container already starting for this folder is announced as soon as the bridge
    // connects: then this offer would be beside the point.
    setTimeout(async () => {
      if (containerSeen) return;
      const reopen = hasDevContainer ? "Reopen in Container" : "Open in Container";
      const never = "Don't Show Again...";
      const names = others.map((f) => path.basename(f));
      const text = hasDevContainer
        ? "Folder contains a Dev Container configuration file. Reopen folder to develop in a container ([learn more](https://containers.dev))."
        : (names.length === 1 ? "Folder '" + names[0] + "' contains" : "Folders " + names.map((n) => "'" + n + "'").join(", ") + " contain") +
          " a Dev Container configuration file. Open it in a container, in a new Paseo tab ([learn more](https://containers.dev)).";
      const choice = await vscode.window.showInformationMessage(text, reopen, never);
      if (choice === reopen) return hasDevContainer ? actions.reopenInContainer() : actions.openFolderInContainer();
      if (choice !== never) return;
      const scope = await vscode.window.showQuickPick(
        [
          { label: "This Folder", description: "Do not show this notification again for this folder", key: "folder" },
          { label: "All Folders", description: "Do not show this notification again for any folder", key: "all" },
        ],
        { placeHolder: "Don't show again" },
      );
      if (scope?.key === "folder") await context.workspaceState.update(HIDE_FOLDER, true);
      if (scope?.key === "all") await context.globalState.update(HIDE_ALL, true);
    }, 2500);
  }

  // A dev container starting for this folder (Paseo shows this local window meanwhile):
  // a progress notification and the log in a "Dev Containers" terminal, like VS Code.
  let containerSeen = false;
  let progress = null;
  let terminal = null;
  let write = null;
  function logTerminal() {
    if (terminal) return terminal;
    const emitter = new vscode.EventEmitter();
    let opened = false;
    const queued = [];
    write = (text) => (opened ? emitter.fire(text) : queued.push(text));
    terminal = vscode.window.createTerminal({
      name: "Dev Containers",
      iconPath: new vscode.ThemeIcon("remote-explorer"),
      pty: {
        onDidWrite: emitter.event,
        open() { opened = true; for (const t of queued.splice(0)) emitter.fire(t); },
        close() { terminal = null; write = null; },
      },
    });
    return terminal;
  }
  function log(text) {
    logTerminal();
    write(text.replace(/\r?\n/g, "\r\n") + "\r\n");
  }
  function showLog() {
    logTerminal().show(true);
  }
  function endProgress() {
    if (progress) progress.done();
    progress = null;
    vscode.commands.executeCommand("setContext", "paseo.containerStarting", false);
  }
  function onContainer(message) {
    containerSeen = true;
    if (message.state === "ready") {
      endProgress();
      log("\x1b[32mThe dev container is ready.\x1b[0m");
      return;
    }
    if (message.state === "error") {
      endProgress();
      log("\x1b[31m" + (message.message || "The dev container did not start.") + "\x1b[0m");
      vscode.window
        .showErrorMessage("The dev container did not start. " + (message.message || "").split("\n")[0], "Retry", "Reopen Folder Locally", "Show Log")
        .then((choice) => {
          if (choice === "Retry") run("retry-container", "Starting the dev container…");
          else if (choice === "Reopen Folder Locally") run("reopen-locally", "Reopening locally…");
          else if (choice === "Show Log") showLog();
        });
      return;
    }
    const step = message.state === "installing" ? "Downloading VS Code for the container…" : message.message || "Starting…";
    if (!progress) {
      vscode.commands.executeCommand("setContext", "paseo.containerStarting", true);
      showLog();
      let report = null;
      let resolve = null;
      let latest = step;
      let finished = false;
      progress = {
        report(text) { latest = text; if (report) report(text); },
        done() { finished = true; if (resolve) resolve(); },
      };
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Starting Dev Container ([show log](command:paseo.showContainerLog))" },
        (p) => {
          report = (text) => p.report({ message: text });
          report(latest);
          return new Promise((r) => { resolve = r; if (finished) r(); });
        },
      );
    }
    progress.report(step);
  }
  context.subscriptions.push(vscode.commands.registerCommand("paseo.showContainerLog", showLog));

  function connect() {
    if (stopped) return;
    const query = "?folders=" + encodeURIComponent(JSON.stringify(folders()));
    const onResponse = (res) => {
      if (res.statusCode !== 200) { res.resume(); return retry(); }
      res.setEncoding("utf8");
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = event.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          if (!data) continue;
          try {
            const message = JSON.parse(data);
            if (message.type === "open" && typeof message.path === "string") open(message);
            else if (message.type === "container") onContainer(message);
            else if (message.type === "container-log" && typeof message.text === "string") log(message.text);
            else if (message.type === "container-reset") endProgress();
          } catch {}
        }
      });
      res.on("end", retry);
      res.on("error", retry);
    };
    // Inside a dev container the plugin is reached through a Unix socket.
    const where = target("events" + query);
    request = socketPath ? http.get({ ...where, headers }, onResponse) : http.get(where, { headers }, onResponse);
    request.on("error", retry);
  }
  let retrying = false;
  function retry() {
    if (stopped || retrying) return;
    retrying = true;
    setTimeout(() => { retrying = false; connect(); }, 1000);
  }
  connect();
}

module.exports = { activate, deactivate() {} };
`;

/** Writes the extension into VS Code's built-in extensions folder (idempotent). */
export async function installBridgeExtension(builtinExtensionsDir: string): Promise<void> {
  const dir = path.join(builtinExtensionsDir, "paseo-bridge");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify(MANIFEST, null, 2));
  await writeFile(path.join(dir, "extension.js"), EXTENSION_JS);
}
