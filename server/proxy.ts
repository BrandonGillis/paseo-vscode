import http from "node:http";
import net from "node:net";
import { APPEARANCE_PARAM, type PaseoAppearance } from "../shared/appearance";
import type { Bridge } from "./bridge";
import { chromeColors, parseAppearance, workbenchDefaults } from "./defaults";
import { READY_PATH, READY_SCRIPT } from "./ready-script";

/*
 * The only way into code-server.
 *
 * code-server listens on a Unix socket that only this user can open (mode 600) and runs
 * with --auth none: the socket's permissions are the access control. Paseo's iframe cannot
 * talk to a socket, so this proxy:
 *   - listens on 127.0.0.1 only;
 *   - accepts only paths under /<secret>/, a random value made at each start, and strips it
 *     before forwarding (code-server uses relative URLs, so it works under any prefix):
 *     the URL itself is the credential and nothing else is reachable;
 *   - writes Paseo's colors into the Paseo theme and picks it in the workbench
 *     configuration (see theme-extension.ts and defaults.ts).
 */

export interface Proxy {
  port: number;
  /** http://127.0.0.1:<port>/<secret>/ */
  baseUrl: string;
  close(): void;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);

const decodeAttr = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const encodeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface WindowIndicator {
  label: string;
  tooltip: string;
}

/**
 * Adds configuration defaults to the workbench page (IWorkbenchConstructionOptions), and
 * the label of VS Code's remote indicator (bottom left; its menu lists the actions
 * extensions add to "statusBar/remoteIndicator").
 */
function injectDefaults(html: string, defaults: Record<string, unknown>, windowIndicator: WindowIndicator | null): string {
  return html.replace(
    /(<meta id="vscode-workbench-web-configuration" data-settings=")([^"]*)(")/,
    (whole, start: string, settings: string, end: string) => {
      try {
        const config = JSON.parse(decodeAttr(settings));
        config.configurationDefaults = { ...config.configurationDefaults, ...defaults };
        if (windowIndicator) config.windowIndicator = windowIndicator;
        return `${start}${encodeAttr(JSON.stringify(config))}${end}`;
      } catch {
        return whole;
      }
    },
  );
}

/**
 * Paints Paseo's color behind VS Code before it loads, and loads the ready script (see
 * ready-script.ts) with the editor color the Paseo theme will produce.
 */
function injectLoading(html: string, editorBackground: string | null): string {
  const tags = [
    editorBackground ? `<meta name="paseo-editor-background" content="${editorBackground}">` : "",
    editorBackground ? `<style>html,body{background:${editorBackground}}</style>` : "",
    `<script src=".${READY_PATH}"></script>`,
  ].join("");
  return html.includes("</head>") ? html.replace("</head>", `${tags}</head>`) : html;
}

/** The path to forward, without /<secret>; null when the request is not for us. */
function upstreamPath(url: string | undefined, secret: string): string | null {
  if (!url) return null;
  const prefix = `/${secret}`;
  if (url === prefix || url.startsWith(`${prefix}?`)) return null; // redirected to "/<secret>/" below
  if (!url.startsWith(`${prefix}/`)) return null;
  return url.slice(prefix.length);
}

export function startProxy(options: {
  secret: string;
  /** code-server's socket, once it listens. */
  upstreamSocket: () => string | null;
  bridge: Bridge;
  /** Port used last time, kept when free (see below). */
  preferredPort?: number;
  /** More configuration defaults (a dev container's settings), below Paseo's. */
  extraDefaults?: () => Record<string, unknown>;
  /** Replaces code-server's "code-server Web" remote indicator. */
  windowIndicator?: () => WindowIndicator | null;
  /** Called with Paseo's look before the workbench page is served (writes the Paseo theme). */
  onAppearance?: (appearance: PaseoAppearance) => Promise<void>;
}): Promise<Proxy> {
  const { secret, bridge } = options;

  const server = http.createServer((req, res) => {
    if (bridge.handle(req, res)) return;
    const prefix = `/${secret}`;
    // code-server's relative URLs need the trailing slash.
    if (req.url === prefix || req.url?.startsWith(`${prefix}?`)) {
      res.writeHead(302, { location: `${prefix}/${req.url.slice(prefix.length)}` }).end();
      return;
    }
    const target = upstreamPath(req.url, secret);
    if (target === null) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    if (target === READY_PATH) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }).end(READY_SCRIPT);
      return;
    }
    const socketPath = options.upstreamSocket();
    if (!socketPath) {
      res.writeHead(503, { "content-type": "text/plain" }).end("VS Code is starting");
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(key)) headers[key] = value;
    // Uncompressed, so the workbench page can be edited below. Costs nothing locally.
    headers["accept-encoding"] = "identity";
    const upstream = http.request({ socketPath, method: req.method, path: target, headers }, (upRes) => {
      const type = String(upRes.headers["content-type"] ?? "");
      if (!type.startsWith("text/html")) {
        res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, upRes.headers);
        upRes.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      upRes.on("data", (chunk: Buffer) => chunks.push(chunk));
      upRes.on("end", async () => {
        const query = new URL(req.url ?? "/", "http://x").searchParams;
        const appearance = parseAppearance(query.get(APPEARANCE_PARAM));
        // The theme file must hold these colors before the page asks VS Code for it.
        if (appearance && options.onAppearance) await options.onAppearance(appearance).catch(() => {});
        const defaults = { ...options.extraDefaults?.(), ...workbenchDefaults(appearance, appearance?.scheme ?? "dark") };
        const editorBackground = appearance ? chromeColors(appearance.colors)["editor.background"] : null;
        const html = injectLoading(injectDefaults(Buffer.concat(chunks).toString("utf8"), defaults, options.windowIndicator?.() ?? null), editorBackground);
        const body = Buffer.from(html, "utf8");
        const outHeaders = { ...upRes.headers, "content-length": String(body.length) };
        delete outHeaders["transfer-encoding"];
        res.writeHead(upRes.statusCode ?? 200, upRes.statusMessage, outHeaders);
        res.end(body);
      });
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("VS Code is not reachable");
    });
    req.pipe(upstream);
  });

  // WebSockets (the workbench connection, terminals, extension host): raw tunnel.
  server.on("upgrade", (req, socket, head) => {
    const target = upstreamPath(req.url, secret);
    const socketPath = options.upstreamSocket();
    if (target === null || !socketPath) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const upstream = net.connect(socketPath, () => {
      const lines = [`${req.method} ${target} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on("error", close);
    socket.on("error", close);
  });

  // The same port as last time when free: the browser sees the same origin, so VS Code keeps
  // what it stores there (its theme cache, which avoids a flash of its default theme, and its
  // window state). The secret path still changes at every start.
  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("Proxy has no port"));
        resolve(address.port);
      });
    });
  return (async () => {
    let port: number;
    try {
      port = options.preferredPort ? await listen(options.preferredPort) : await listen(0);
    } catch {
      port = await listen(0);
    }
    return { port, baseUrl: `http://127.0.0.1:${port}/${secret}/`, close: () => server.close() };
  })();
}
