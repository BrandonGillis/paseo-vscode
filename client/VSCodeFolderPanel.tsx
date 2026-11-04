import { useRpc, useTranslation, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { openFolderTabRpc } from "../shared/rpc";
import { messages } from "./messages";
import { VSCodeView } from "./VSCodeView";

/** `relative` resolved against the workspace folder (POSIX paths: Linux and macOS hosts). */
function resolve(base: string, relative: string): string {
  const parts = base.split("/");
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.length > 1 && parts.pop();
    else parts.push(part);
  }
  return parts.join("/") || "/";
}

/**
 * A folder tab ("Open Folder in Container..."): the folder at `relative` in this tab's
 * workspace, in its dev container. The same tab in another worktree shows that worktree's
 * folder, in its own container.
 */
export function VSCodeFolderPanel({ relative, workspaceId, theme }: PluginWorkspacePanelProps & { relative: string }) {
  const { t } = useTranslation(messages);
  const workspace = useWorkspace(workspaceId, (w) => w.directory);
  const directory = workspace ? resolve(workspace, relative) : null;
  const prepare = useRpc(openFolderTabRpc);
  const [state, setState] = useState<"checking" | "ready" | "missing">("checking");

  useEffect(() => {
    if (!directory) return;
    let cancelled = false;
    setState("checking");
    void prepare({ directory })
      .then((r) => !cancelled && setState(r.devcontainer ? "ready" : "missing"))
      .catch(() => !cancelled && setState("ready"));
    return () => {
      cancelled = true;
    };
  }, [directory, prepare]);

  if (state === "ready") return <VSCodeView directory={directory} workspaceId={workspaceId} theme={theme} />;
  const c = theme.colors;
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: c.surface0 }}>
      {state === "missing" ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 12, textAlign: "center" }}>{t("noDevContainer", { folder: relative })}</Text>
      ) : (
        <ActivityIndicator size="small" color={c.foregroundMuted} />
      )}
    </View>
  );
}
