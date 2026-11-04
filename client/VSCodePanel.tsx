import { useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { VSCodeView } from "./VSCodeView";

/** The workspace's VS Code, opened from the Command Center. */
export function VSCodePanel({ workspaceId, theme }: PluginWorkspacePanelProps) {
  const directory = useWorkspace(workspaceId, (w) => w.directory);
  return <VSCodeView directory={directory} workspaceId={workspaceId} theme={theme} />;
}
