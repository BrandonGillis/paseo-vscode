// Paseo's look, passed from the panel to the proxy in the VS Code URL (?paseo=<base64url JSON>)
// so VS Code's defaults can match it. Everything is validated on the server side.

export interface PaseoAppearance {
  scheme: "dark" | "light";
  colors: {
    surface0: string;
    surface1: string;
    surface2: string;
    border: string;
    foreground: string;
    foregroundMuted: string;
    accent: string;
    accentForeground: string;
  };
  /** Paseo's code font settings, when the user changed them. */
  fontFamily?: string;
  fontSize?: number;
}

export const APPEARANCE_PARAM = "paseo";
