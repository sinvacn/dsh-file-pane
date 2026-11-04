# dsh-file-pane

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.5-4c6ef5)](https://github.com/deepseek-ai/deepseek-harness)

A VS Code/Codex-style file pane for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) right sidebar: the tree stays on the right while files open on the left, with preview/pin tabs, line-aware file links, path copying, a right-click terminal, and Copy to Chat.

English | [中文](README.zh.md)

## Screenshots

[![4-pane layout: viewer and file tree](docs/layout-4-pane.png)](docs/layout-4-pane.png)

**4-pane layout.** The original right pane is split into two: a viewer on the left and the Workspace file tree on the right. Three panes become four, and code and files stay side by side.

[![Copy to Chat: editor context menu and chat composer](docs/copy-to-chat.png)](docs/copy-to-chat.png)

**Copy to Chat.** Select code in the preview and right-click. The `@file #Lx-Ly` reference and the selected code are inserted into the composer, without sending.

## Features

- **File pane on the left** — a file opened from the Workspace files tree lands in a pane to the *left* of the tree, so the tree stays visible on the right at a 70/30 split. If DSH cannot split or move the tab, it falls back to the stock behavior.
- **Preview tabs, VS Code-style** — a single click opens or replaces the one preview tab; a double click on a file (or on the tab) pins it. Preview tabs render in italics, and pinning is per session.
- **Line-aware file links** — a chat link to `src/app.ts:42` opens the file in the preview and scrolls to line 42. `:12-20` and `:12:5` (line:column) start at line 12; the native `#L42` / `#L42-L50` form works too.
- **Copy paths** — right-click a file or folder to copy its workspace-relative path (`src/app.ts`) or absolute path; right-click empty space to copy the workspace root. Relative paths outside the workspace fall back to absolute.
- **Open Terminal** — right-click a file (it opens in the file's folder), a folder, or empty space in the tree to open a terminal there. The terminal opens as a sibling tab in the file pane, not over the tree.
- **Copy / Copy to Chat** — select text in the file preview and right-click. *Copy* keeps the native copy; *Copy to Chat* inserts a `@file #Lx-Ly` reference plus the selected code as a fenced block into the composer, without sending it.

Example payload:

````
@src/app.ts #L12-L14
```ts
export const b = 2
```
````

## Install

Tested with DSH `0.2.1-rc.5`.

```sh
dsh plugin --profile desktop add github:sinvacn/dsh-file-pane
```

Or just ask the agent in chat:

> Install the dsh-file-pane plugin: `dsh plugin --profile desktop add github:sinvacn/dsh-file-pane`

The agent runs the command for you (it needs shell access; approve the command if asked). Either way, **dsh-file-pane** is added to your profile and the sidebar row is registered automatically. If the plugin is off, enable it in **Settings → Plugins**.

Refresh the page once; restart the desktop app if the sidebar does not update.

## Configuration

The default share for a new split is `0.7` (file/terminal pane on the left). Change it from the page console:

```js
localStorage.setItem('dsh.file-pane.share', '0.7')
```

Values are clamped to `0.2`–`0.8`. Existing splits keep their real ratio; drag a divider to adjust one.

## Uninstall

Remove **dsh-file-pane** in **Settings → Plugins**, or run:

```sh
dsh plugin --profile desktop remove dsh-file-pane
```

Then refresh the page.

## Limitations

- The right sidebar's total width cap is unchanged; existing splits keep their real ratio.
- If you keep the tree on the left yourself, files and terminals open in the right-hand sibling pane instead of swapping panes.
- Line ranges come from code and plain-text previews; Markdown/PDF previews insert the file reference and selected text without numbers.
- A file whose name literally ends in `:<digits>` is treated as a line reference by chat links (rare).
- Copy to Chat only inserts into the composer; it never sends. Without a mounted composer, the payload is copied to the clipboard instead.
- The terminal changes into the target directory after it starts, so the `cd …` command stays in shell history and scrollback.

## License

[MIT](LICENSE)
