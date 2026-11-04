Runs VS Code in a Paseo tab, on the workspace folder. It is code-server by Coder, the open source build of VS Code that runs in a browser, so extensions, tasks, the integrated terminal, the debugger, settings and keyboard shortcuts work as in VS Code.

Open it from the Command Center with Open VS Code, or from Paseo's tabs. Paseo's file explorer can also open files in it.

## Downloads

Before its first start, the plugin asks you to confirm a download of code-server 4.144.0 (about 220 MB) from Coder's GitHub releases. Opening a dev container also needs the official dev container CLI (about 2 MB) from the npm registry, confirmed the same way. Nothing is downloaded until you accept. Both are kept in ~/.paseo/plugin-data/paseo-vscode, with VS Code's settings and extensions; delete that folder to reset.

## Extensions

Extensions come from Open VSX, the open marketplace also used by VSCodium and Cursor. Install them from VS Code's Extensions view, or list them under Settings, Plugins, VS Code to have them installed automatically. A few Microsoft-only extensions, such as Pylance, C# Dev Kit or Live Share, are not published there.

## Appearance

VS Code uses Paseo Dark or Paseo Light, themes generated from your Paseo colors, and your code font. Its AI chat, welcome page and workspace trust prompt are turned off. These are defaults: anything you set in VS Code wins.

## Dev containers

A workspace with a devcontainer.json asks once whether to open in its dev container or locally. In the container, code-server runs inside it, so the terminal, tasks, debugger, language servers and extensions run there. The container is built by the official dev container CLI and reused when it already runs. Switch or rebuild from VS Code's remote indicator, at the bottom left, or its command palette. Needs Docker.

## Requirements and privacy

Needs Paseo 0.15.0 or later and a Linux or macOS daemon host (x64 or arm64) on the same machine as the Paseo app. Works on desktop and web; the mobile apps are not supported.

code-server runs on the daemon host, on a socket only your user can open. Paseo reaches it through a local address holding a secret created at each start. VS Code's telemetry and update checks are turned off. VS Code contacts Open VSX when you browse or install extensions, and extensions you install may send their own data, as in VS Code.

Not affiliated with Microsoft or Coder.
