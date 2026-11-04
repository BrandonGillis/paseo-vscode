import type http from "node:http";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";

/*
 * The plugin side of "Paseo Bridge" (see bridge-extension.ts). Each VS Code window's
 * extension host keeps a server-sent events stream open here and receives "open" messages
 * for its folder. Requests that arrive before the window is connected wait for it (the
 * first file link may be what opened VS Code).
 *
 * The window also posts actions chosen in VS Code (reopen locally, in the dev container,
 * rebuild) to `${BRIDGE_PATH}/action`.
 */

export const BRIDGE_PATH = "/__paseo_bridge";
const PENDING_TTL_MS = 60_000;

export interface OpenFileMessage {
  type: "open";
  path: string;
  line?: number;
  endLine?: number;
}

export const BRIDGE_ACTIONS = [
  "reopen-locally",
  "reopen-in-container",
  "rebuild-container",
  "rebuild-and-reopen-in-container",
  "retry-container",
  // A folder of the window (multi-root) or one of its subfolders, in its own Paseo tab.
  "open-folder-in-container",
] as const;
export type BridgeAction = (typeof BRIDGE_ACTIONS)[number];

/** How the folder's dev container start goes, shown by the local window of that folder. */
export interface ContainerStatusMessage {
  type: "container";
  state: "installing" | "building" | "starting" | "ready" | "error";
  message?: string;
}

const MAX_LOG_CHUNKS = 5000;

interface Client {
  folders: string[];
  res: http.ServerResponse;
}

const inside = (file: string, folder: string) => {
  const rel = path.relative(folder, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export class Bridge {
  private clients = new Set<Client>();
  private pending: { folder: string; message: OpenFileMessage; at: number }[] = [];
  /** Per folder: the dev container start in progress, replayed to windows that connect late. */
  private containers = new Map<string, { status: ContainerStatusMessage; log: string[] }>();

  /**
   * Runs an action posted by a VS Code window of `folder` (a path as VS Code sees it).
   * `origin` is the folder the window was opened on (the Paseo workspace), when it differs.
   */
  onAction: ((folder: string, action: BridgeAction, origin?: string) => Promise<void>) | null = null;

  constructor(readonly token: string) {}

  private authorized(req: http.IncomingMessage) {
    const header = String(req.headers.authorization ?? "");
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
    const expected = Buffer.from(this.token);
    // Only VS Code's extension host calls the bridge: from this machine, never a browser.
    return given.length === expected.length && timingSafeEqual(given, expected) && !req.headers.origin;
  }

  /** Serves the events stream. Returns false when the request is not for the bridge. */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith(BRIDGE_PATH + "/")) return false;
    if (!this.authorized(req)) {
      res.writeHead(403).end();
      return true;
    }
    if (url.pathname === `${BRIDGE_PATH}/action` && req.method === "POST") {
      this.action(req, res);
      return true;
    }
    if (url.pathname !== `${BRIDGE_PATH}/events` || req.method !== "GET") {
      res.writeHead(404).end();
      return true;
    }
    let folders: string[] = [];
    try {
      const parsed = JSON.parse(url.searchParams.get("folders") ?? "[]");
      if (Array.isArray(parsed)) folders = parsed.filter((f): f is string => typeof f === "string");
    } catch {
      // no folders
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": connected\n\n");
    const client: Client = { folders, res };
    this.clients.add(client);
    for (const folder of folders) {
      const container = this.containers.get(folder);
      if (!container) continue;
      for (const text of container.log) this.write(client, { type: "container-log", text });
      this.write(client, container.status);
    }
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      this.clients.delete(client);
    });
    this.flush();
    return true;
  }

  private action(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 8192) req.destroy();
    });
    req.on("end", () => {
      let folder: unknown;
      let action: unknown;
      let origin: unknown;
      try {
        ({ folder, action, origin } = JSON.parse(body));
      } catch {
        // invalid
      }
      if (typeof folder !== "string" || !BRIDGE_ACTIONS.includes(action as BridgeAction) || !this.onAction) {
        res.writeHead(400).end();
        return;
      }
      // Answered first: the action may stop the VS Code window that asked for it.
      res.writeHead(202).end();
      void this.onAction(folder, action as BridgeAction, typeof origin === "string" && origin ? origin : undefined).catch((error) =>
        console.warn(`[paseo-vscode] ${action} failed: ${error instanceof Error ? error.message : error}`),
      );
    });
  }

  /** Opens a file in the VS Code window of `folder`, now or as soon as it connects. */
  open(folder: string, message: OpenFileMessage) {
    // A newer request for the same folder replaces an older one still waiting.
    this.pending = this.pending.filter((p) => p.folder !== folder);
    this.pending.push({ folder, message, at: Date.now() });
    this.flush();
  }

  private write(client: Client, message: object) {
    client.res.write(`data: ${JSON.stringify(message)}\n\n`);
  }

  private broadcast(folder: string, message: object) {
    for (const c of this.clients) if (c.folders.includes(folder)) this.write(c, message);
  }

  /** The dev container of `folder` moves on. "ready" ends it: nothing is replayed after. */
  containerStatus(folder: string, status: ContainerStatusMessage) {
    const container = this.containers.get(folder) ?? { status, log: [] };
    container.status = status;
    this.containers.set(folder, container);
    this.broadcast(folder, status);
    if (status.state === "ready") this.containers.delete(folder);
  }

  containerLog(folder: string, text: string) {
    const container = this.containers.get(folder);
    if (!container) return;
    container.log.push(text);
    if (container.log.length > MAX_LOG_CHUNKS) container.log.splice(0, container.log.length - MAX_LOG_CHUNKS);
    this.broadcast(folder, { type: "container-log", text });
  }

  /** Forgets the folder's dev container start (reopened locally, retried). */
  containerReset(folder: string) {
    if (this.containers.delete(folder)) this.broadcast(folder, { type: "container-reset" });
  }

  private flush() {
    const now = Date.now();
    this.pending = this.pending.filter((p) => now - p.at < PENDING_TTL_MS);
    const remaining: typeof this.pending = [];
    for (const p of this.pending) {
      const targets = [...this.clients].filter((c) => c.folders.some((f) => f === p.folder || inside(p.message.path, f)));
      if (!targets.length) {
        remaining.push(p);
        continue;
      }
      for (const c of targets) c.res.write(`data: ${JSON.stringify(p.message)}\n\n`);
    }
    this.pending = remaining;
  }

  close() {
    for (const c of this.clients) c.res.end();
    this.clients.clear();
    this.pending = [];
    this.containers.clear();
  }
}
