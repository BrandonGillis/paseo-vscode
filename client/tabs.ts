import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { createElement } from "react";
import { folderTabsRpc } from "../shared/rpc";
import { VSCodeFolderPanel } from "./VSCodeFolderPanel";

/*
 * Folder tabs: VS Code on a folder of the workspace rather than the workspace itself, a
 * repo of a multi-root workspace (or a subfolder) opened in its own dev container from
 * VS Code's "Open Folder in Container...".
 *
 * Paseo identifies a plugin tab by its panel id, gives workspace panels no params, and
 * fixes a panel's title when it is registered. So each folder gets a panel of its own,
 * titled with its devcontainer.json name. They are registered again at startup (from the
 * server's list) so their tabs come back after a restart.
 *
 * A folder is relative to the workspace ("src/api"): the panel shows that folder of the
 * workspace it is opened in, so each worktree has its own.
 */

interface FolderTab {
  relative: string;
  name: string;
}

let client: PluginClientContext | null = null;
const panels = new Map<string, { name: string; remove: () => void }>();

/** A stable panel id for a relative folder path. */
function panelId(relative: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (let i = 0; i < relative.length; i++) {
    const c = relative.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 31) + c) >>> 0;
  }
  return `vscode-folder-${h1.toString(36)}${h2.toString(36)}`;
}

function register({ relative, name }: FolderTab): string {
  const id = panelId(relative);
  const existing = panels.get(id);
  if (existing?.name === name) return id;
  existing?.remove();
  const Component = (props: PluginWorkspacePanelProps) => createElement(VSCodeFolderPanel, { ...props, relative });
  const remove = client!.addWorkspacePanel({ id, title: name, icon: "Container", Component });
  panels.set(id, { name, remove });
  return id;
}

/** Called by the plugin's client entry; returns the cleanup. */
export function setupFolderTabs(ctx: PluginClientContext): () => void {
  client = ctx;
  void ctx
    .rpc(folderTabsRpc, {})
    .then(({ folders }) => {
      if (client === ctx) folders.forEach(register);
    })
    .catch(() => {});
  return () => {
    for (const panel of panels.values()) panel.remove();
    panels.clear();
    client = null;
  };
}

/** Opens (or focuses) the tab of `folder` in the workspace. */
export function openFolderTab(workspaceId: string, folder: FolderTab) {
  if (!client) return;
  client.openPanel(register(folder), { workspaceId });
}
