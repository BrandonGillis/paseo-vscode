import { execCommand } from "@getpaseo/plugin/server";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EXTENSION_ID } from "../shared/settings";
import { DATA_DIR, SERVER_BIN } from "./install";

export const EXTENSIONS_DIR = path.join(DATA_DIR, "extensions");
export const SERVER_DATA_DIR = path.join(DATA_DIR, "user-data");
/** code-server's config file for the plugin (auth: none; it listens on a private socket). */
export const CONFIG_FILE = path.join(DATA_DIR, "code-server.yaml");

/** Ids in VS Code's installed list (extensions.json), lowercased. */
async function installedIds(): Promise<Set<string>> {
  try {
    const list = JSON.parse(await readFile(path.join(EXTENSIONS_DIR, "extensions.json"), "utf8")) as { identifier?: { id?: string } }[];
    return new Set(list.map((e) => String(e.identifier?.id ?? "").toLowerCase()));
  } catch {
    return new Set();
  }
}

/**
 * Installs the configured extensions that are missing, from Open VSX, with VS Code's own
 * CLI. Never uninstalls: extensions added by hand in VS Code stay. Returns failures.
 */
export async function ensureExtensions(ids: readonly string[]): Promise<string[]> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, "auth: none\ncert: false\n", { mode: 0o600 });
  const installed = await installedIds();
  const missing = ids.filter((id) => EXTENSION_ID.test(id) && !installed.has(id.toLowerCase()));
  const failures: string[] = [];
  for (const id of missing) {
    try {
      // --config: code-server would otherwise read, or create, ~/.config/code-server/config.yaml.
      await execCommand(SERVER_BIN, ["--config", CONFIG_FILE, "--extensions-dir", EXTENSIONS_DIR, "--user-data-dir", SERVER_DATA_DIR, "--install-extension", id], {
        timeout: 180_000,
      });
    } catch (error) {
      failures.push(`${id}: ${error instanceof Error ? error.message.split("\n").slice(-2).join(" ") : String(error)}`);
    }
  }
  return failures;
}
