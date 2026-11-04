/*
 * One VS Code window (iframe) per workspace, shared by every Paseo tab that shows it: the
 * VS Code panel and each file opened "with VS Code". The visible tab claims the iframe and
 * it moves there. Element.moveBefore keeps the iframe alive while it moves (a plain
 * appendChild would reload VS Code); between owners it waits in an off-screen holder.
 *
 * While at least one tab shows it, this client holds a lease on VS Code (renewed every
 * LEASE_RENEW_MS). When the last tab closes, the window is destroyed and the lease released,
 * so the plugin stops VS Code (and its extensions) once no client needs it.
 *
 * Paseo 0.15 does not tell a plugin whether a tab was closed or only unmounted (it unmounts
 * the tabs of a workspace left inactive for 10 minutes): both stop VS Code. Coming back to
 * such a workspace starts VS Code again.
 */

import { LEASE_RENEW_MS } from "../shared/rpc";

/** Identifies this Paseo window for the server's leases. */
const CLIENT_ID = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `c${Date.now()}${Math.random()}`;
/** A tab closed and another opened right away (or Paseo remounting one) keeps VS Code. */
const CLOSE_GRACE_MS = 3_000;

type Lease = (input: { directory: string; client: string; active: boolean }) => Promise<unknown>;

interface Views {
  count: number;
  lease: Lease;
  heartbeat: ReturnType<typeof setInterval> | null;
  closing: ReturnType<typeof setTimeout> | null;
}

const views = new Map<string, Views>();

/**
 * A tab showing the workspace's VS Code mounted. Returns its unmount callback; when the last
 * tab of the workspace is gone, VS Code's window is destroyed and the lease released.
 */
export function registerView(key: string, lease: Lease): () => void {
  let v = views.get(key);
  if (!v) {
    v = { count: 0, lease, heartbeat: null, closing: null };
    views.set(key, v);
  }
  v.count++;
  v.lease = lease;
  if (v.closing) {
    clearTimeout(v.closing);
    v.closing = null;
  }
  if (!v.heartbeat) {
    const renew = () => void v!.lease({ directory: key, client: CLIENT_ID, active: true }).catch(() => {});
    renew();
    v.heartbeat = setInterval(renew, LEASE_RENEW_MS);
  }
  const current = v;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    current.count--;
    if (current.count > 0) return;
    current.closing = setTimeout(() => {
      if (current.count > 0) return;
      if (current.heartbeat) clearInterval(current.heartbeat);
      views.delete(key);
      destroyFrame(key);
      void current.lease({ directory: key, client: CLIENT_ID, active: false }).catch(() => {});
    }, CLOSE_GRACE_MS);
  };
}

function destroyFrame(key: string) {
  const entry = entries.get(key);
  if (!entry) return;
  entry.frame?.remove();
  entries.delete(key);
  entry.listeners.forEach((l) => l());
}

interface Entry {
  frame: HTMLIFrameElement;
  url: string;
  owner: symbol | null;
  /** VS Code shows the Paseo theme (its ready script said so); hidden until then. */
  ready: boolean;
  listeners: Set<() => void>;
}

const READY_MESSAGE = "paseo-vscode-ready";

// Only the VS Code window itself can mark itself ready.
if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    if ((event.data as { type?: unknown } | null)?.type !== READY_MESSAGE) return;
    for (const entry of entries.values()) {
      if (!entry.frame || event.source !== entry.frame.contentWindow || entry.ready) continue;
      entry.ready = true;
      entry.frame.style.visibility = "visible";
      entry.listeners.forEach((l) => l());
    }
  });
}

const entries = new Map<string, Entry>();
let holder: HTMLDivElement | null = null;

function getHolder(): HTMLDivElement {
  if (!holder || !holder.isConnected) {
    holder = document.createElement("div");
    holder.setAttribute("aria-hidden", "true");
    // Full size so VS Code keeps its layout while parked; never visible or interactive.
    holder.style.cssText = "position:fixed;left:-200vw;top:0;width:100vw;height:100vh;visibility:hidden;pointer-events:none;";
    document.body.appendChild(holder);
  }
  return holder;
}

function move(parent: HTMLElement, node: HTMLElement) {
  if (node.parentElement === parent) return;
  const moveBefore = (parent as unknown as { moveBefore?: (n: Node, ref: Node | null) => void }).moveBefore;
  if (typeof moveBefore === "function" && node.isConnected) {
    try {
      moveBefore.call(parent, node, null);
      return;
    } catch {
      // fall through
    }
  }
  parent.appendChild(node);
}

function entryFor(key: string, url: string): Entry {
  let entry = entries.get(key);
  if (!entry?.frame) {
    const frame = document.createElement("iframe");
    frame.title = "VS Code";
    frame.allow = "clipboard-read; clipboard-write";
    // Hidden until VS Code shows the Paseo theme: no flash of its default theme.
    frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;display:block;visibility:hidden;background:transparent;";
    frame.src = url;
    getHolder().appendChild(frame);
    entry = { frame, url, owner: null, ready: false, listeners: entry?.listeners ?? new Set() };
    entries.set(key, entry);
  } else if (entry.url !== url) {
    // Paseo's look changed: VS Code reloads with the new defaults, hidden until themed.
    entry.url = url;
    entry.ready = false;
    entry.frame.style.visibility = "hidden";
    entry.frame.src = url;
    entry.listeners.forEach((l) => l());
  }
  return entry;
}

const notify = (entry: Entry) => entry.listeners.forEach((l) => l());

/** Moves the workspace's VS Code into `container`. */
export function claimFrame(key: string, url: string, container: HTMLElement, owner: symbol) {
  const entry = entryFor(key, url);
  move(container, entry.frame);
  if (entry.owner !== owner) {
    entry.owner = owner;
    notify(entry);
  }
}

/** Parks the iframe if `owner` still holds it (its tab is going away). */
export function releaseFrame(key: string, owner: symbol) {
  const entry = entries.get(key);
  if (!entry || entry.owner !== owner) return;
  move(getHolder(), entry.frame);
  entry.owner = null;
  notify(entry);
}

export function frameReady(key: string): boolean {
  return entries.get(key)?.ready ?? false;
}

export function frameOwner(key: string): symbol | null {
  return entries.get(key)?.owner ?? null;
}

export function subscribeFrame(key: string, listener: () => void): () => void {
  let entry = entries.get(key);
  if (!entry) {
    // Subscribing before the frame exists: keep the listener for when it does.
    entry = { frame: null as unknown as HTMLIFrameElement, url: "", owner: null, ready: false, listeners: new Set() };
    entries.set(key, entry);
  }
  entry.listeners.add(listener);
  return () => entry!.listeners.delete(listener);
}

// Command Center actions (reopen locally / in the dev container, rebuild) ask every tab of
// a workspace to start over.
const refreshers = new Map<string, Set<() => void>>();

export function subscribeRefresh(key: string, listener: () => void): () => void {
  let set = refreshers.get(key);
  if (!set) {
    set = new Set();
    refreshers.set(key, set);
  }
  set.add(listener);
  return () => set!.delete(listener);
}

export function refreshWorkspace(key: string) {
  refreshers.get(key)?.forEach((l) => l());
}
