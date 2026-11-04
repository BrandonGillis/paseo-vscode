import type { PluginServerContext } from "@getpaseo/plugin/server";
import { VSCodeHost } from "./server/vscode";
import { approveDownloadsRpc, folderTabsRpc, leaseRpc, openFolderTabRpc, openFileRpc, openRpc, rebuildRpc, setModeRpc, targetRpc } from "./shared/rpc";
import { settings } from "./shared/settings";
import { approve } from "./server/downloads";

export default function contribute(server: PluginServerContext) {
  const config = server.registerSettings(settings);
  const extensions = async () => {
    const state = await config.read();
    return state.status === "ready" ? state.values.extensions : [];
  };
  const host = new VSCodeHost(extensions);
  // Extensions added in the settings are installed right away (VS Code shows them once its
  // window reloads); removing one does not uninstall it.
  const unsubscribe = config.subscribe(() => void host.syncExtensions());
  server.handle(openRpc, ({ directory }) => host.open(directory));
  server.handle(approveDownloadsRpc, ({ downloads }) => (approve(downloads), { ok: true }));
  server.handle(setModeRpc, async ({ directory, mode }) => (await host.setMode(directory, mode), { ok: true }));
  server.handle(rebuildRpc, async ({ directory }) => (await host.rebuild(directory), { ok: true }));
  server.handle(leaseRpc, ({ directory, client, active }) => (host.lease(directory, client, active), { ok: true }));
  server.handle(folderTabsRpc, () => ({ folders: host.listFolderTabs() }));
  server.handle(openFolderTabRpc, async ({ directory }) => (await host.openFolderTab(directory), { devcontainer: host.workspaceInfo(directory).devcontainer }));
  server.handle(targetRpc, ({ directory, path }) => ({ directory: host.targetFor(directory, path) }));
  server.handle(openFileRpc, ({ directory, path, lineStart, lineEnd }) => host.openFile(directory, path, lineStart, lineEnd));
  return () => {
    unsubscribe();
    void host.stop();
  };
}
