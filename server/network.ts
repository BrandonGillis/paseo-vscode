/*
 * Where the VS Code proxy listens and which URL the browser is given for it.
 *
 * By default both are 127.0.0.1: fine when the Paseo app runs on the daemon host, broken
 * when it connects from another machine (the iframe would open the app machine's own
 * 127.0.0.1). The settings below let a reverse proxy (with TLS) put VS Code on a public URL.
 */

export interface Network {
  /** Address the proxy listens on. */
  listenHost: string;
  /** Fixed port for the local session's proxy; 0: sticky random port. */
  port: number;
  /** Base URL given to the browser; `{port}` is replaced. Empty: http://127.0.0.1:<port>. */
  publicUrl: string;
}

const DEFAULT: Network = { listenHost: "127.0.0.1", port: 0, publicUrl: "" };

let loader: () => Promise<Partial<Network>> = async () => ({});
let current: Network = DEFAULT;

/** Set by the server entry: reads the plugin settings. */
export function setNetworkLoader(load: () => Promise<Partial<Network>>) {
  loader = load;
}

/** Reads the settings again; called before each start, so a change applies on the next one. */
export async function loadNetwork(): Promise<Network> {
  try {
    current = { ...DEFAULT, ...(await loader()) };
  } catch (error) {
    console.warn(`[paseo-vscode] Could not read network settings: ${String(error)}`);
    current = DEFAULT;
  }
  return current;
}

export function network(): Network {
  return current;
}

const ANY = new Set(["0.0.0.0", "::", "[::]"]);

/** An address on this machine that reaches the proxy (for the Paseo Bridge extension). */
export function loopbackHost(): string {
  const host = current.listenHost;
  if (ANY.has(host)) return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** The URL the browser opens for a proxy on `port`, ending with `/<secret>/`. */
export function browserUrl(port: number, secret: string): string {
  const base = current.publicUrl ? current.publicUrl.replaceAll("{port}", String(port)).replace(/\/+$/, "") : `http://127.0.0.1:${port}`;
  return `${base}/${secret}/`;
}
