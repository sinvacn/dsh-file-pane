# dsh-file-pane

[English](README.md) | 中文

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）右栏的文件体验接近 VS Code：文件开在 Workspace files 树的**左侧**，树的展开状态和滚动位置保留；文件 tab 支持 preview / pin；右键可直接开终端；选中代码可一键 Copy to Chat。

## 截图

<!--
把下面四张图换成你自己的 16:9 截图（建议 1200x675），文件名保持不变即可。
-->

| 1. 文件在左侧 pane | 2. VS Code 式 preview tab |
| :---: | :---: |
| [![文件在左侧 pane](docs/file-pane.png)](docs/file-pane.png) | [![VS Code 式 preview tab](docs/preview-tabs.png)](docs/preview-tabs.png) |
| **3. 右键打开 Terminal** | **4. Copy / Copy to Chat** |
| [![右键打开 Terminal](docs/terminal.png)](docs/terminal.png) | [![Copy 和 Copy to Chat](docs/copy-to-chat.png)](docs/copy-to-chat.png) |

## 功能

1. 点击文件，在右栏**左侧**的 pane 打开，Workspace files 树留在**右侧**（默认 7:3）。
2. 文件 tab 是 VS Code 式 preview tab：单击替换，双击固定，双击 tab 也能固定。
3. 右键文件/目录：单行 **Open Terminal**；右键空白处：在项目根目录打开 Terminal；Terminal 打开在文件详情同栏（兄弟 pane）。
4. 文件编辑器里选中文本后右键：**Copy** 和 **Copy to Chat**，把文件引用（带行范围）+ 选中代码插入对话输入框。

## 安装

测试于 DSH `0.2.1-rc.5`。

```sh
dsh plugin --profile desktop add github:sinvacn/dsh-file-pane
```

安装会把 **dsh-file-pane** 加进 profile 的 `dsh.profile.bundles`；如果未启用，在 **Settings → Plugins** 里打开即可。插件自带的 patch 会注册 entry，不需要手动改 `cordis.patch.yml`。

刷新 Harness 页面；Host 支持 HMR 时会自动重载，否则重启一次桌面 App。使用 Web profile 时把 `--profile desktop` 换成对应的 profile 名。

## 卸载

1. 在 **Settings → Plugins** 里关闭并移除 **dsh-file-pane**；
2. 或执行 `dsh plugin --profile desktop remove dsh-file-pane`；
3. 刷新页面或重启 App。

## 1. 文件落在左侧 pane

- 只处理 `dsh-resource://file/...`，且打开动作来自包含 Workspace files 树的 pane。
- **只有一个 docked pane**：先在树 pane 打开文件，再调用 docking kit 的 `dropTab(..., 'left')`，在树 pane 的左边插入新 pane 并移动文件 tab。树 tab 不关闭，展开状态和滚动位置保留。
- **已经有两个 pane**：直接打开/移动到不含树的兄弟 pane。
- 没空间 split、找不到 surface、或 `dropTab` 拒绝时，回落到 DSH 原行为。

为什么不用 `split()`：它固定 `direction: 'after'`，新 pane 永远在右边，只能得到 `[tree | file]`；`dropTab(tabId, paneId, 'left')` 才支持插到左边。

## 2. Preview tab（VS Code 式）

- **单击**文件：打开/替换唯一的 preview tab；再单击另一个文件，替换它，不增加 tab。
- **双击**文件：把当前打开的这个文件 tab 变成固定 tab。
- **双击文件 tab**：把 preview tab 变成固定 tab。
- 单击已经固定的文件：只聚焦，不会把它变成 preview，也不会替换现有 preview。
- preview tab 的标题显示为斜体（tab chip 上 `data-file-pane-preview`）。
- preview 状态不持久化：刷新页面后恢复的 tab 都视为固定 tab。

## 3. 右键 Terminal

- 右键文件/目录行：只显示单行 **Open Terminal**，不再显示路径。
- 右键 Workspace files 空白处：在项目根目录（`data-files-root`）打开 Terminal。
- 右键文件：在该文件的父目录打开；右键目录：在该目录打开。
- Terminal tab 打开在**文件详情所在的兄弟 pane**：
  - 右栏只有一个 pane 时，自动 split 成 `[terminal | Workspace files]`，默认 70/30。
  - 已经有两个 pane 时，作为文件 pane 的新 tab 打开，和文件详情并排。
- DSH 的 Terminal API 只按 Session cwd 创建，没有 per-tab cwd；插件在终端进入 running/writable 后自动发送：
  - POSIX shell：`cd '<目录>' && clear`
  - PowerShell：`Set-Location -LiteralPath '<目录>'; Clear-Host`
  - cmd：`cd /d "<目录>" && cls`
  可见屏幕会立即清空，只留下目标目录的 prompt，看起来像“直接一步到位”。
  代价是这条命令仍会进入 shell history 和终端 scrollback；要真正零命令启动，需要核心 Terminal API 支持 per-tab cwd。

## 4. Copy / Copy to Chat

在文件详情 pane 里用鼠标选中文本，右键会显示：

```
Copy
Copy to Chat
```

- **Copy** 保留原来的复制行为（写入选区到剪贴板）。
- **Copy to Chat** 在对话输入框的当前光标处插入：

```
@plugin-test-a.ts #L2-L4
```ts
export const b = 2
export const c = 3
export const d = 4
```
```

- 文件引用 `@path` 是独立的、可点击的引用 chip；行范围以 DSH 现有的 `#L12-L20` 形式跟在后面，中间用空格分开，避免 `#L` 进入文件路径导致 chip 无法打开。
- Workspace 内的文件用相对路径；workspace 外或无法计算相对路径时用绝对路径；含空格的路径用 `@"..."`。
- 代码块语言按扩展名推断；选区里含反引号时会自动加长 fence。
- 插入到当前 caret，不会自动发送；输入框已有内容时会补空行。

文件引用桥：插件在 `conversation.session.header.actions` 注册一个不可见组件，接收 `inputActions` 和 `useInput`，按 Session 保存，右键菜单通过 `captureInsertion()` + `insertText()` 写入。没有输入框（例如 Conversation 没挂载）时，payload 会退回复制到剪贴板并打印 warning。

## 调整 pane 宽度

1. **手动拖 divider**：按 Session 记住比例。
2. 改新 split 的默认比例：

```js
localStorage.setItem('dsh.file-pane.share', '0.7') // 文件/终端 pane 占 70%
```

值夹在 `0.2`–`0.8`，默认 `0.7`。只影响之后新建的 split；已有 split 拖一次 divider 即可。

## 调试

```js
globalThis.__FILE_PANE_DEBUG__ = true    // 打开文件拦截/移动的详细日志
globalThis.__FILE_PANE_DISABLED__ = true // 临时绕过文件打开逻辑，回到原行为
```

两者都在页面 console 设置，刷新后失效。右键菜单和 Copy to Chat 不受 DISABLED 影响（仍可用）。

## 已知限制

- 依赖侧栏 controller 的 `adopted`、store 的 `dropTab`/`resizeSplit`，以及 composer 的 `inputActions`；这些是内部实现，不是公开 API，DSH 升级后需要回归。
- 右栏总宽度上限不变；新 split 默认 70/30，已有 split 不会被自动改写。
- 如果用户手动把树放在左边，插件会把文件/终端放到右边的兄弟 pane，而不是交换 pane 顺序。
- 文件 tab 的 `contentId` 必须等于资源地址；目前文档预览类型满足。
- 行范围计算支持代码预览（`pre .line`）和纯文本预览（`data-textpreview-line`）；Markdown/PDF 等没有行映射的预览只插入文件引用和选中文本，不带行号。
- Copy to Chat 只插入到输入框，不发送；没有输入框时退回复制 payload。
- Terminal 的 `cd ... && clear` 是启动后发送的：可见屏幕是干净的，但 shell history / scrollback 里仍能看到这条命令；Host 元数据里的初始 cwd 仍是 Session cwd。

## 开发与测试

```sh
node test/run.mjs
```

10/10 通过，覆盖：单 pane 左侧插入、默认 70/30、比例配置与夹取、preview 替换、pin 后新开 tab、pin 文件再聚焦、双 pane 替换、非文件资源、无树 pane、terminal 路径与 `cd` 命令、dispose 还原。

真实 Host 端到端验证（DSH 0.2.1-rc.5）：

- preview：A 单击 preview → B 单击替换 → 双击 C 固定 → 单击 A 出现新 preview → 双击 A tab 固定 → 单击 B 再出现 preview（最终 3 个固定 + 1 个 preview）。
- Terminal：右键目录只出现 1 个菜单项 `Open Terminal`；点击后文件 pane 增加 `zsh` tab；截图确认屏幕已清空、prompt 直接在 `plugin-test-dir`。
- Copy to Chat：选中 3 行代码，菜单显示 `Copy` / `Copy to Chat`；点击后输入框内容为 `@plugin-test-a.ts #L2-L4` + 3 行代码块（之后把行范围改为空格分隔 `@plugin-test-a.ts #L2-L4`，让 `@path` chip 保持独立可点击）。
- 浏览器 console 无异常。测试文件和测试终端已清理。

## License

[MIT](LICENSE)
