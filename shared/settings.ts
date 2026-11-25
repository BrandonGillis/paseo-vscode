import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** An Open VSX extension id: publisher.name (what VS Code's Extensions view shows). */
export const EXTENSION_ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/i;

export const settings = defineSettings({
  id: "settings",
  scope: "host",
  version: 1,
  schema: z.object({
    /**
     * Installed from Open VSX when VS Code starts, if missing. Empty by default: each user
     * picks their own (for example bmewburn.vscode-intelephense-client for PHP).
     */
    extensions: z.array(z.string().regex(EXTENSION_ID)).default([]),
    /**
     * Address the proxy in front of code-server listens on. 127.0.0.1 (the default) works
     * only when the Paseo app runs on the daemon host. Set it to an address your reverse
     * proxy can reach (for example the host's LAN address, or 0.0.0.0) to open VS Code from
     * another machine.
     */
    listenHost: z.string().trim().min(1).default("127.0.0.1"),
    /** Fixed port for the local VS Code proxy; 0 keeps the previous behavior (sticky, random). */
    port: z.number().int().min(0).max(65535).default(0),
    /**
     * URL the browser opens instead of http://127.0.0.1:<port>, normally a TLS reverse proxy
     * in front of listenHost. `{port}` is replaced by the proxy's port (needed for dev
     * containers, which get a port each). Empty: http://127.0.0.1:<port>.
     */
    publicUrl: z
      .string()
      .trim()
      .refine((value) => value === "" || /^https?:\/\/[^/\s]+(\/[^\s]*)?$/.test(value), "Expected http(s)://host[/path]")
      .default(""),
  }),
});
