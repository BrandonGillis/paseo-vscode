import { useRpc, useWorkspace, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useState } from "react";
import { openFileRpc, targetRpc } from "../shared/rpc";
import { VSCodeView } from "./VSCodeView";

/**
 * A file opened "with VS Code" (a chat link, the file explorer...): the workspace's VS Code,
 * or that of the folder holding the file when it opens in its own dev container, showing
 * this file at the requested lines. Coming back to the tab shows it again.
 */
export function VSCodeFilePanel({ workspaceId, file, params, theme }: PluginFilePanelProps) {
  const workspace = useWorkspace(workspaceId, (w) => w.directory);
  const openFile = useRpc(openFileRpc);
  const resolveTarget = useRpc(targetRpc);
  const [directory, setDirectory] = useState<string | null>(null);
  const { lineStart, lineEnd } = params;

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    void resolveTarget({ directory: workspace, path: file.path })
      .then((r) => r.directory)
      .catch(() => workspace)
      .then((target) => {
        if (!cancelled) setDirectory(target);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, file.path, resolveTarget]);

  const show = useCallback(() => {
    if (!directory) return;
    void openFile({ directory, path: file.path, lineStart, lineEnd }).catch(() => {});
  }, [directory, file.path, lineStart, lineEnd, openFile]);
  return <VSCodeView directory={workspace ? directory : null} workspaceId={workspaceId} theme={theme} onShown={show} />;
}
