import { useRpc, useTranslation, type PluginHostProps } from "@getpaseo/plugin/client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { approveDownloadsRpc, leaseRpc, openRpc, setModeRpc, type DOWNLOADS } from "../shared/rpc";
import { vscodeUrl } from "./appearance";
import { claimFrame, frameOwner, frameReady, registerView, releaseFrame, subscribeFrame, subscribeRefresh } from "./frames";
import { messages } from "./messages";
import { openFolderTab } from "./tabs";

type Status =
  | { kind: "loading" }
  | { kind: "installing"; progress: number }
  | { kind: "starting"; message?: string }
  | { kind: "building"; message?: string }
  | { kind: "choose" }
  | { kind: "download"; downloads: Download[] }
  | { kind: "ready"; url: string }
  | { kind: "error"; message: string };

type Download = (typeof DOWNLOADS)[number];

const POLL_MS = 700;
/** Once VS Code is up: notices "Reopen Locally", "Rebuild"... chosen in VS Code. */
const READY_POLL_MS = 1_500;

export interface VSCodeViewProps {
  /** The folder whose VS Code this shows: the workspace's, or one of its folders'. */
  directory: string | null;
  /** The Paseo workspace, for the tabs VS Code asks to open. */
  workspaceId?: string;
  theme: PluginHostProps["theme"];
  /** Called each time this tab becomes visible with VS Code in it. */
  onShown?: () => void;
}

/** The workspace's VS Code window, shared with the other tabs showing it (see frames.ts). */
export function VSCodeView({ directory, workspaceId, theme, onShown }: VSCodeViewProps) {
  const { t } = useTranslation(messages);
  const c = theme.colors;
  const open = useRpc(openRpc);
  const lease = useRpc(leaseRpc);
  const setMode = useRpc(setModeRpc);
  const approveDownloads = useRpc(approveDownloadsRpc);
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [visible, setVisible] = useState(false);
  const [owned, setOwned] = useState(false);
  const [themed, setThemed] = useState(false);
  const hostRef = useRef<View>(null);
  const owner = useRef(Symbol("vscode-tab")).current;
  const onShownRef = useRef(onShown);
  onShownRef.current = onShown;

  // Ask the server until VS Code is up (the first launch downloads it).
  useEffect(() => {
    if (!directory) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const r = await open({ directory });
        if (cancelled) return;
        // "Open Folder in Container..." chosen in this VS Code: a tab of its own.
        if (workspaceId) for (const folder of r.tabs ?? []) openFolderTab(workspaceId, folder);
        if (r.status === "ready" && r.url) {
          // Keep watching: a switch or rebuild chosen inside VS Code changes the session.
          const url = r.url;
          setStatus((current) => (current.kind === "ready" && current.url === url ? current : { kind: "ready", url }));
          timer = setTimeout(poll, READY_POLL_MS);
          return;
        }
        if (r.status === "error") return setStatus({ kind: "error", message: r.message ?? "" });
        // The workspace has a dev container and no mode yet: wait for the user's choice.
        if (r.status === "choose") return setStatus({ kind: "choose" });
        // Something to download first: wait for the user to accept.
        if (r.status === "download") return setStatus({ kind: "download", downloads: r.downloads ?? [] });
        if (r.status === "installing") setStatus({ kind: "installing", progress: r.progress ?? 0 });
        else if (r.status === "building") setStatus({ kind: "building", message: r.message });
        else setStatus({ kind: "starting", message: r.message });
      } catch (error) {
        if (cancelled) return;
        return setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
      timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory, attempt]);

  // Switched to the other mode from the first-open card.
  useEffect(() => {
    if (!directory) return;
    return subscribeRefresh(directory, () => {
      setStatus({ kind: "loading" });
      setAttempt((n) => n + 1);
    });
  }, [directory]);

  const choose = (mode: "local" | "container") => {
    if (!directory) return;
    setStatus({ kind: "loading" });
    void setMode({ directory, mode })
      .catch(() => {})
      .then(() => setAttempt((n) => n + 1));
  };

  const download = (downloads: Download[]) => {
    setStatus({ kind: "loading" });
    void approveDownloads({ downloads })
      .catch(() => {})
      .then(() => setAttempt((n) => n + 1));
  };

  // Paseo's look, turned into VS Code defaults by the proxy. A change reloads VS Code.
  const url = status.kind === "ready" ? vscodeUrl(status.url, theme) : null;
  const key = directory ?? "";

  // Track whether this tab is on screen (Paseo hides inactive tabs).
  useLayoutEffect(() => {
    const host = hostRef.current as unknown as HTMLElement | null;
    if (!host) return;
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!key) return;
    const sync = () => {
      setOwned(frameOwner(key) === owner);
      setThemed(frameReady(key));
    };
    sync();
    return subscribeFrame(key, sync);
  }, [key, owner]);

  // Becoming visible takes VS Code from whichever tab had it. Layout effect: the iframe must
  // leave this tab before React removes its DOM, or VS Code would be destroyed with it.
  useLayoutEffect(() => {
    const host = hostRef.current as unknown as HTMLElement | null;
    if (!url || !host || !visible) return;
    claimFrame(key, url, host, owner);
    onShownRef.current?.();
  }, [url, visible, key, owner]);

  useLayoutEffect(() => () => releaseFrame(key, owner), [key, owner]);

  // Counts this tab among the workspace's VS Code tabs: the last one to close stops VS Code.
  useEffect(() => {
    if (!key) return;
    return registerView(key, lease);
  }, [key, lease]);

  const button = (label: string, onPress: () => void, primary: boolean) => (
    <Pressable
      onPress={onPress}
      style={({ hovered }: { hovered?: boolean }) => ({
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: primary ? c.accent : c.border,
        backgroundColor: primary ? c.accent : hovered ? c.surface1 : "transparent",
      })}
    >
      <Text style={{ color: primary ? c.accentForeground : c.foreground, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );

  const centered = { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 } as const;
  let overlay = null;
  if (!directory) {
    overlay = <Text style={{ color: c.foregroundMuted }}>{t("noFolder")}</Text>;
  } else if (status.kind === "installing") {
    const percent = Math.round(status.progress * 100);
    overlay = (
      <>
        <Text style={{ color: c.foreground, fontSize: 13 }}>{t("installing", { percent })}</Text>
        <View style={{ width: 240, height: 4, borderRadius: 2, backgroundColor: c.surface2, overflow: "hidden" }}>
          <View style={{ width: `${percent}%`, height: 4, backgroundColor: c.accent }} />
        </View>
        <Text style={{ color: c.foregroundMuted, fontSize: 11, textAlign: "center" }}>{t("installingNote")}</Text>
      </>
    );
  } else if (status.kind === "download") {
    const { downloads } = status;
    overlay = (
      <View style={{ maxWidth: 460, gap: 12, alignItems: "center" }}>
        <Text style={{ color: c.foreground, fontSize: 15, fontWeight: "600" }}>{t("downloadTitle")}</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12, textAlign: "center" }}>{t("downloadBody")}</Text>
        <View style={{ alignSelf: "stretch", gap: 6 }}>
          {downloads.map((d) => (
            <Text key={d} style={{ color: c.foreground, fontSize: 12, textAlign: "center" }}>
              {t(d === "code-server" ? "downloadCodeServer" : "downloadCli")}
            </Text>
          ))}
        </View>
        <View style={{ marginTop: 4 }}>{button(t("downloadAccept"), () => download(downloads), true)}</View>
        <Text style={{ color: c.foregroundMuted, fontSize: 11, textAlign: "center" }}>{t("downloadNote")}</Text>
      </View>
    );
  } else if (status.kind === "choose") {
    overlay = (
      <View style={{ maxWidth: 440, gap: 12, alignItems: "center" }}>
        <Text style={{ color: c.foreground, fontSize: 15, fontWeight: "600" }}>{t("chooseTitle")}</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12, textAlign: "center" }}>{t("chooseBody")}</Text>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
          {button(t("openLocally"), () => choose("local"), false)}
          {button(t("openInContainer"), () => choose("container"), true)}
        </View>
        <Text style={{ color: c.foregroundMuted, fontSize: 11, textAlign: "center" }}>{t("chooseNote")}</Text>
      </View>
    );
  } else if (status.kind === "building") {
    overlay = (
      <>
        <ActivityIndicator size="small" color={c.foregroundMuted} />
        <Text style={{ color: c.foreground, fontSize: 13 }}>{t("building")}</Text>
        {/* A fixed two-line slot: log lines of any length never push into, or draw over,
            the text around them, and the layout does not jump as they change. */}
        <View style={{ alignSelf: "stretch", alignItems: "center", height: 32, overflow: "hidden" }}>
          <Text
            numberOfLines={2}
            style={{ width: "100%", maxWidth: 560, color: c.foregroundMuted, fontSize: 11, lineHeight: 16, fontFamily: "monospace", textAlign: "center", wordBreak: "break-all" } as never}
          >
            {status.message ?? ""}
          </Text>
        </View>
        <Text style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 16, textAlign: "center" }}>{t("buildingNote")}</Text>
      </>
    );
  } else if (status.kind === "loading" || status.kind === "starting" || (status.kind === "ready" && !themed)) {
    overlay = (
      <>
        <ActivityIndicator size="small" color={c.foregroundMuted} />
        {status.kind !== "loading" ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("starting")}</Text> : null}
      </>
    );
  } else if (status.kind === "error") {
    overlay = (
      <>
        <Text style={{ color: c.statusDanger, fontSize: 13 }}>{t("error")}</Text>
        <Text selectable style={{ color: c.foregroundMuted, fontSize: 11, fontFamily: "monospace", maxWidth: 640 }}>
          {status.message}
        </Text>
        <Pressable
          onPress={() => {
            setStatus({ kind: "loading" });
            setAttempt((n) => n + 1);
          }}
          style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 4, backgroundColor: c.accent }}
        >
          <Text style={{ color: c.accentForeground, fontSize: 12 }}>{t("retry")}</Text>
        </Pressable>
      </>
    );
  } else if (visible && !owned) {
    // Two tabs showing VS Code side by side: only one can hold it.
    overlay = (
      <>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("elsewhere")}</Text>
        <Pressable
          onPress={() => {
            const host = hostRef.current as unknown as HTMLElement | null;
            if (host && url) {
              claimFrame(key, url, host, owner);
              onShownRef.current?.();
            }
          }}
          style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 4, borderWidth: 1, borderColor: c.border }}
        >
          <Text style={{ color: c.foreground, fontSize: 12 }}>{t("showHere")}</Text>
        </Pressable>
      </>
    );
  }

  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: c.surface0 }}>
      <View ref={hostRef} style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }} />
      {overlay ? <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, ...centered }}>{overlay}</View> : null}
    </View>
  );
}
