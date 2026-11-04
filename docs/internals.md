# dsh-file-pane 实现细节

面向开发者：左侧插入、preview 状态、terminal cwd、Copy to Chat 桥、调试与测试。普通使用见 [README.zh.md](../README.zh.md)。

## 文件落在左侧 pane

- 只处理 `dsh-resource://file/...`，且打开动作来自包含 Workspace files 树的 pane。
- **只有一个 docked pane**：先在树 pane 打开文件，再调用 docking kit 的 `dropTab(..., 'left')`，在树 pane 的左边插入新 pane 并移动文件 tab。树 tab 不关闭，展开状态和滚动位置保留。
- **已经有两个 pane**：直接打开/移动到不含树的兄弟 pane。
- 没空间 split、找不到 surface、或 `dropTab` 拒绝时，回落到 DSH 原行为。

为什么不用 `split()`：它固定 `direction: 'after'`，新 pane 永远在右边，只能得到 `[tree | file]`；`dropTab(tabId, paneId, 'left')` 才支持插到左边。

## Preview tab（VS Code 式）

- **单击**文件：打开/替换唯一的 preview tab；再单击另一个文件，替换它，不增加 tab。
- **双击**文件：把当前打开的这个文件 tab 变成固定 tab。
- **双击文件 tab**：把 preview tab 变成固定 tab。
- 单击已经固定的文件：只聚焦，不会把它变成 preview，也不会替换现有 preview。
- preview tab 的标题显示为斜体（tab chip 上 `data-file-pane-preview`）。
- preview 状态不持久化：刷新页面后恢复的 tab 都视为固定 tab。

## 带行号的链接

- DSH 的 Markdown 链接原本就支持 `path#L12` / `path#L12-L20`：链接渲染器把 `line` 放进 `sidebarRight.openResource(url, { params: { line } })`，文本预览会高亮并滚动到 `data-textpreview-line`。
- 插件补上更常见的 `path:12` 写法（也接受 `:12-20`、`line:column`，都从第一行开始）：
  - 同时拦截 **`sidebarRight.openResource`**（聊天里的 Markdown 链接、`@file` chip 走这里）和 **`openResourceIn`**（文件树和 tab 动作走这里）。
  - 从 `dsh-resource://file/…` address 末尾拆掉 `:line`，用不带行号的 address 打开 tab，并把 `line` 合并进 `navigation.params`。
  - 目标行还没加载时，预览会继续分页加载，加载到后滚动并高亮。
- 歧义：文件名本身以 `:<数字>` 结尾时会被当成行号（极少见）；`__FILE_PANE_DISABLED__` 会同时关闭这个拆分。

## 右键菜单：复制路径与 Terminal

- 右键文件/目录行：依次显示 **Copy Relative Path**、**Copy Absolute Path**、**Open Terminal**。
  - 相对路径相对 Workspace 根（`data-files-root`），目录名不带结尾分隔符；不在根下或无法计算时退回复制绝对路径。
  - 右键 Workspace files 空白处：复制的是项目根目录，相对路径为 `.`。
- **Open Terminal**：右键文件在该文件的父目录打开；右键目录在该目录打开；右键空白处在项目根目录打开。
- Terminal tab 打开在**文件详情所在的兄弟 pane**：
  - 右栏只有一个 pane 时，自动 split 成 `[terminal | Workspace files]`，默认 70/30。
  - 已经有两个 pane 时，作为文件 pane 的新 tab 打开，和文件详情并排。
- DSH 的 Terminal API 只按 Session cwd 创建，没有 per-tab cwd；插件在终端进入 running/writable 后自动发送：
  - POSIX shell：`cd '<目录>' && clear`
  - PowerShell：`Set-Location -LiteralPath '<目录>'; Clear-Host`
  - cmd：`cd /d "<目录>" && cls`

  可见屏幕会立即清空，只留下目标目录的 prompt。代价是这条命令仍会进入 shell history 和终端 scrollback；要真正零命令启动，需要核心 Terminal API 支持 per-tab cwd。

## Copy / Copy to Chat

- **Copy** 保留原来的复制行为（写入选区到剪贴板）。
- **Copy to Chat** 在对话输入框的当前光标处插入 `@path #Lx-Ly` 引用 + 代码块。
- 文件引用 `@path` 是独立的、可点击的引用 chip；行范围以 DSH 现有的 `#L12-L20` 形式跟在后面，中间用空格分开，避免 `#L` 进入文件路径导致 chip 无法打开。
- Workspace 内的文件用相对路径；workspace 外或无法计算相对路径时用绝对路径；含空格的路径用 `@"..."`。
- 代码块语言按扩展名推断；选区里含反引号时会自动加长 fence。
- 插入到当前 caret，不会自动发送；输入框已有内容时会补空行。

文件引用桥：插件在 `conversation.session.header.actions` 注册一个不可见组件，接收 `inputActions` 和 `useInput`，按 Session 保存，右键菜单通过 `captureInsertion()` + `insertText()` 写入。没有输入框（例如 Conversation 没挂载）时，payload 会退回复制到剪贴板并打印 warning。

## 调试

```js
globalThis.__FILE_PANE_DEBUG__ = true    // 打开文件拦截/移动的详细日志
globalThis.__FILE_PANE_DISABLED__ = true // 临时绕过文件打开逻辑，回到原行为
```

两者都在页面 console 设置，刷新后失效。右键菜单和 Copy to Chat 不受 DISABLED 影响（仍可用）；带行号链接的拆分则会关闭，回到 DSH 原行为。

## 开发与测试

```sh
node test/run.mjs
```

13/13 通过，覆盖：单 pane 左侧插入、默认 70/30、比例配置与夹取、preview 替换、pin 后新开 tab、pin 文件再聚焦、双 pane 替换、非文件资源、无树 pane、terminal 路径与 `cd` 命令、复制相对/绝对路径、带行号 address 的拆分与参数合并、dispose 还原。

真实 Host 端到端验证（DSH 0.2.1-rc.5）：

- preview：A 单击 preview → B 单击替换 → 双击 C 固定 → 单击 A 出现新 preview → 双击 A tab 固定 → 单击 B 再出现 preview（最终 3 个固定 + 1 个 preview）。
- Terminal：点击菜单里的 `Open Terminal` 后文件 pane 增加 `zsh` tab；截图确认屏幕已清空、prompt 直接在 `plugin-test-dir`。（0.2.0 起该菜单前面新增 `Copy Relative Path` / `Copy Absolute Path` 两项；路径计算由 `test/run.mjs` 覆盖。）
- Copy to Chat：选中 3 行代码，菜单显示 `Copy` / `Copy to Chat`；点击后输入框内容为 `@plugin-test-a.ts #L2-L4` + 3 行代码块（之后把行范围改为空格分隔 `@plugin-test-a.ts #L2-L4`，让 `@path` chip 保持独立可点击）。
- 浏览器 console 无异常。测试文件和测试终端已清理。
