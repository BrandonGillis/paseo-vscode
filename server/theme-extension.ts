import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PaseoAppearance } from "../shared/appearance";
import { chromeColors, PASEO_DARK, PASEO_LIGHT } from "./defaults";

/*
 * "Paseo Theme": a built-in VS Code extension contributing two color themes, Paseo Dark and
 * Paseo Light. Each one includes VS Code's Dark Modern / Light Modern (so code looks exactly
 * the same) and replaces the workbench colors with the active Paseo theme's. The theme files
 * are rewritten when Paseo's colors change; the official themes are left untouched.
 */

// Dark Modern includes Dark+, which includes Dark (Visual Studio); same for light.
const BASE_THEMES = ["dark_modern", "dark_plus", "dark_vs", "light_modern", "light_plus", "light_vs"];

const MANIFEST = {
  name: "paseo-theme",
  displayName: "Paseo Theme",
  description: "VS Code's Modern themes with the colors of your Paseo theme.",
  publisher: "paseo",
  version: "1.0.0",
  engines: { vscode: "^1.80.0" },
  categories: ["Themes"],
  contributes: {
    themes: [
      { id: PASEO_DARK, label: PASEO_DARK, uiTheme: "vs-dark", path: "./themes/paseo-dark.json" },
      { id: PASEO_LIGHT, label: PASEO_LIGHT, uiTheme: "vs", path: "./themes/paseo-light.json" },
    ],
  },
};

const themeFile = (dir: string, scheme: "dark" | "light") => path.join(dir, "paseo-theme", "themes", `paseo-${scheme}.json`);

function themeJson(scheme: "dark" | "light", colors: Record<string, string>) {
  return JSON.stringify(
    {
      $schema: "vscode://schemas/color-theme",
      name: scheme === "dark" ? PASEO_DARK : PASEO_LIGHT,
      type: scheme,
      include: scheme === "dark" ? "./dark_modern.json" : "./light_modern.json",
      colors,
    },
    null,
    2,
  );
}

/**
 * Installs the extension (at VS Code's start: built-ins are scanned then). Both themes start
 * as plain Modern until Paseo's colors arrive.
 */
export async function installThemeExtension(builtinExtensionsDir: string): Promise<void> {
  const dir = path.join(builtinExtensionsDir, "paseo-theme");
  const themes = path.join(dir, "themes");
  await mkdir(themes, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify(MANIFEST, null, 2));
  const official = path.join(builtinExtensionsDir, "theme-defaults", "themes");
  for (const base of BASE_THEMES) await copyFile(path.join(official, `${base}.json`), path.join(themes, `${base}.json`));
  for (const scheme of ["dark", "light"] as const) {
    const file = themeFile(builtinExtensionsDir, scheme);
    // Keep the last Paseo colors across restarts; only create missing files.
    await readFile(file).catch(() => writeFile(file, themeJson(scheme, {})));
  }
}

/** Writes Paseo's current colors into the matching theme, if they changed. */
export async function updateTheme(builtinExtensionsDir: string, appearance: PaseoAppearance): Promise<void> {
  const file = themeFile(builtinExtensionsDir, appearance.scheme);
  const next = themeJson(appearance.scheme, chromeColors(appearance.colors));
  const current = await readFile(file, "utf8").catch(() => "");
  if (current === next) return;
  // Atomic: VS Code may be reading the theme at the same moment.
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, next);
  await rename(temp, file);
}
