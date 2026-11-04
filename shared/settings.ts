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
  }),
});
