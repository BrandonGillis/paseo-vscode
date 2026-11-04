import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { messages } from "./client/messages";
import { EXTENSIONS, FILENAMES } from "./client/files";
import { VSCodeFilePanel } from "./client/VSCodeFilePanel";
import { SettingsScreen } from "./client/SettingsScreen";
import { VSCodePanel } from "./client/VSCodePanel";
import { setupFolderTabs } from "./client/tabs";

const PANEL_ID = "vscode";

export default function contribute(client: PluginClientContext) {
  // VS Code is a web app in an iframe: desktop and web only.
  if (Platform.OS !== "web") return () => {};
  const removePanel = client.addWorkspacePanel({
    id: PANEL_ID,
    title: messages.message("title"),
    icon: "Code",
    Component: VSCodePanel,
  });
  // Folders of the workspace in their own dev container, beside the workspace's VS Code.
  const removeFolderTabs = setupFolderTabs(client);
  const removeCommand = client.addCommandCenterItem({
    id: "open-vscode",
    title: messages.message("open"),
    icon: "Code",
    context: "workspace",
    keywords: ["vscode", "vs code", "code", "editor", "extensions", "tasks"],
    onSelect: (ctx) => ctx.openPanel(PANEL_ID),
  });
  // "Open with VS Code" for files: chat links, the file explorer...
  const removeFilePanel = client.addFilePanel({
    id: "file",
    title: messages.message("title"),
    icon: "Code",
    files: { extensions: EXTENSIONS, filenames: FILENAMES },
    Component: VSCodeFilePanel,
  });
  const removeSettings = client.addSettingsScreen({
    id: "settings",
    title: messages.message("settingsTitle"),
    icon: "Code",
    Component: SettingsScreen,
  });
  return () => {
    removeSettings();
    removeFilePanel();
    removeCommand();
    removeFolderTabs();
    removePanel();
  };
}
