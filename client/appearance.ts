import type { PluginHostProps } from "@getpaseo/plugin/client";
import { APPEARANCE_PARAM, type PaseoAppearance } from "../shared/appearance";

/** Paseo's code font settings, when the user changed them (Settings, Appearance). */
function paseoFonts(): { fontFamily?: string; fontSize?: number } {
  try {
    const s = JSON.parse(localStorage.getItem("@paseo:app-settings") ?? "null");
    return {
      fontFamily: typeof s?.monoFontFamily === "string" && s.monoFontFamily.trim() ? s.monoFontFamily.trim() : undefined,
      fontSize: typeof s?.codeFontSize === "number" ? s.codeFontSize : undefined,
    };
  } catch {
    return {};
  }
}

/** Relative luminance below 0.4 counts as dark. */
export function isDark(color: string): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return true;
  const n = parseInt(m[1], 16);
  const lin = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255) < 0.4;
}

function encode(a: PaseoAppearance): string {
  const bytes = new TextEncoder().encode(JSON.stringify(a));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The VS Code window URL with Paseo's look, which the proxy turns into VS Code defaults. */
export function vscodeUrl(baseUrl: string, theme: PluginHostProps["theme"]): string {
  const c = theme.colors;
  const appearance = encode({
    scheme: isDark(c.surface0) ? "dark" : "light",
    colors: {
      surface0: c.surface0,
      surface1: c.surface1,
      surface2: c.surface2,
      border: c.border,
      foreground: c.foreground,
      foregroundMuted: c.foregroundMuted,
      accent: c.accent,
      accentForeground: c.accentForeground,
    },
    ...paseoFonts(),
  });
  return `${baseUrl}&${APPEARANCE_PARAM}=${appearance}`;
}
