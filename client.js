/**
 * Browser half of file-pane.
 *
 * Two product rules live here:
 *
 * 1. A file opened from the Workspace files tree lands in the pane that does
 *    not hold the tree, with the tree kept on the right:
 *
 *      one docked pane: open in the tree pane, then split "before" that pane
 *      and move the file tab left  ->  [file | tree]
 *
 *      two docked panes: open in (or move to) the pane without the tree
 *
 *    The split-before step is the docking kit's own `dropTab(..., 'left')`
 *    plan; a plain `split()` always inserts after and would give
 *    [tree | file].
 *
 * 2. File tabs behave like an editor's preview tabs:
 *
 *    - single click: one preview tab, replaced by the next single-click;
 *    - double click a file row: the resulting tab becomes permanent;
 *    - double click a tab in the file pane: the preview tab becomes permanent.
 *
 * The preview bit is plugin state (the tab store has no preview field) and is
 * marked on the tab chip so it can render in italic. It is deliberately not
 * persisted: after a reload every restored tab is permanent.
 *
 * The plugin reaches the surface store through the controller's adopted-session
 * map because the public controller exposes navigation but not tab moves or
 * replacement. Everything is best-effort: if the surface cannot be inspected
 * or a move is refused, the original open stands.
 */

window.__ModuleLoader__.load({
  id: 'dsh-file-pane',
  factory(require) {
    const dockkit = require('@deepseek-ai/dsh-client-ui-dockkit')
    const react = require('react')

    const FILE_PREFIX = 'dsh-resource://file/'
    const TAG = 'file-pane'
    const MAX_RETRIES = 3
    const SHARE_KEY = 'dsh.file-pane.share'
    const DEFAULT_FILE_SHARE = 0.7
    const MIN_SHARE = 0.2
    const MAX_SHARE = 0.8
    const NS = 'filePane'
    const zh = {
      openTerminal: '在终端中打开',
      copy: '复制',
      copyToChat: '复制到对话',
    }
    const en = {
      openTerminal: 'Open Terminal',
      copy: 'Copy',
      copyToChat: 'Copy to Chat',
    }

    /** Session -> the Conversation composer actions captured by the bridge. */
    const chatInputs = new Map()

    /** Per-controller Session -> preview tab id. */
    const previews = new WeakMap()

    function previewMap(controller) {
      let map = previews.get(controller)
      if (map === undefined) {
        map = new Map()
        previews.set(controller, map)
      }
      return map
    }

    /** File-pane share of a newly created split; localStorage can override the default. */
    function fileShare() {
      try {
        const raw = globalThis.localStorage?.getItem(SHARE_KEY)
        if (raw === null || raw === undefined || raw === '') return DEFAULT_FILE_SHARE
        const value = Number(raw)
        if (!Number.isFinite(value)) return DEFAULT_FILE_SHARE
        return Math.min(MAX_SHARE, Math.max(MIN_SHARE, value))
      } catch {
        return DEFAULT_FILE_SHARE
      }
    }

    function cssEscape(value) {
      if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') return globalThis.CSS.escape(String(value))
      return String(value).replace(/["\\]/g, '\\$&')
    }

    /** Read one Session's adopted surface without depending on its store type. */
    function surfaceOf(controller, sessionId) {
      const adopted = controller && controller.adopted
      if (!adopted || typeof adopted.get !== 'function') return undefined
      const entry = adopted.get(sessionId)
      const store = entry && entry.store
      if (!store || typeof store.getSnapshot !== 'function') return undefined
      const snapshot = store.getSnapshot()
      return snapshot && snapshot.bySession ? snapshot.bySession[sessionId] : undefined
    }

    /** The bound surface actions, including tab moves/replacements and split resize. */
    function actionsOf(controller, sessionId) {
      const adopted = controller && controller.adopted
      if (!adopted || typeof adopted.get !== 'function') return undefined
      const entry = adopted.get(sessionId)
      return entry && entry.store ? entry.store.actions : undefined
    }

    function paneOfTab(layout, tabId) {
      try {
        return dockkit.findTabPane(layout, tabId)
      } catch {
        return undefined
      }
    }

    function paneOfId(layout, paneId) {
      try {
        return dockkit.getPane(layout, paneId)
      } catch {
        return undefined
      }
    }

    function dockPanes(layout) {
      try {
        return dockkit.dockPaneIds(layout)
      } catch {
        return []
      }
    }

    /** The files tree tab in one pane, if this pane holds one. */
    function treeTabIn(layout, paneId) {
      if (!layout || !layout.tabs) return undefined
      for (const tab of Object.values(layout.tabs)) {
        if (tab.kind !== 'files') continue
        const pane = paneOfTab(layout, tab.id)
        if (pane && pane.id === paneId) return tab
      }
      return undefined
    }

    /** The tab whose content identity is this resource address. */
    function fileTabIn(layout, address) {
      if (!layout || !layout.tabs) return undefined
      for (const tab of Object.values(layout.tabs)) {
        if (tab.contentId === address) return tab
      }
      return undefined
    }

    function moveTab(controller, sessionId, tabId, paneId, zone) {
      const actions = actionsOf(controller, sessionId)
      if (!actions || typeof actions.dropTab !== 'function') return false
      try {
        actions.dropTab(sessionId, tabId, paneId, zone)
        return true
      } catch (error) {
        console.warn(`[${TAG}] tab move failed`, error)
        return false
      }
    }

    function focusTab(controller, tabId) {
      try {
        controller.focus(tabId)
      } catch {
        /* the mounted-session guard owns this; focus is best effort */
      }
    }

    /** Set the initial ratio of the split this plugin just created. */
    function applyDefaultShare(controller, sessionId, treePane, filePane) {
      const surface = surfaceOf(controller, sessionId)
      const layout = surface && surface.layout
      if (!layout || !layout.nodes) return
      const split = Object.values(layout.nodes).find(node =>
        node && node.kind === 'split' && Array.isArray(node.children) &&
        node.children.includes(treePane) && node.children.includes(filePane))
      if (!split) return
      const actions = actionsOf(controller, sessionId)
      if (!actions || typeof actions.resizeSplit !== 'function') return
      const share = fileShare()
      const complement = Math.round((1 - share) * 1000) / 1000
      const sizes = split.children[0] === filePane ? [share, complement] : [complement, share]
      try {
        actions.resizeSplit(sessionId, split.id, sizes)
      } catch (error) {
        console.warn(`[${TAG}] split resize failed`, error)
      }
    }

    // --------------------------------------------------------------- terminal

    /** Parent directory for a file path, tolerating POSIX and Windows separators. */
    function parentPath(path) {
      const trimmed = String(path).replace(/[\\/]+$/, '')
      if (trimmed === '') return String(path)
      const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
      if (index < 0) return trimmed
      if (index === 2 && trimmed[1] === ':') return trimmed.slice(0, 3)
      return trimmed.slice(0, index) || '/'
    }

    /** A `cd` command for the shell the terminal actually started. */
    function terminalCdCommand(shell, cwd) {
      const path = String(cwd)
      const name = `${shell && shell.name ? shell.name : ''} ${shell && shell.path ? shell.path : ''}`.toLowerCase()
      if (name.includes('powershell') || name.includes('pwsh')) {
        return `Set-Location -LiteralPath '${path.replace(/'/g, "''")}'`
      }
      if (/(^|[\\/ ])cmd(\.exe)?($|\s)/.test(name)) {
        return `cd /d "${path.replace(/"/g, '""')}"`
      }
      return `cd '${path.replace(/'/g, "'\\''")}'`
    }

    /** The one-step launch command: change directory, then clear the visible screen. */
    function terminalInitCommand(shell, cwd) {
      const cd = terminalCdCommand(shell, cwd)
      const name = `${shell && shell.name ? shell.name : ''} ${shell && shell.path ? shell.path : ''}`.toLowerCase()
      if (name.includes('powershell') || name.includes('pwsh')) return `${cd}; Clear-Host`
      if (/(^|[\\/ ])cmd(\.exe)?($|\s)/.test(name)) return `${cd} && cls`
      return `${cd} && clear`
    }

    /** Wait for the terminal to accept input, then move its shell to the requested directory. */
    function sendCdWhenReady(view, cwd) {
      const started = Date.now()
      const attempt = () => {
        let snapshot
        try {
          snapshot = view.state.getSnapshot()
        } catch {
          return
        }
        if (snapshot === undefined || snapshot === null) return
        if (snapshot.writable === true && snapshot.info && snapshot.info.state === 'running') {
          try {
            view.write(`${terminalInitCommand(snapshot.info.shell, cwd)}\r`)
          } catch (error) {
            console.warn(`[${TAG}] terminal cd failed`, error)
          }
          return
        }
        if (snapshot.phase === 'failed' || snapshot.phase === 'closed' || snapshot.phase === 'closing') return
        if (Date.now() - started > 20000) return
        setTimeout(attempt, 120)
      }
      attempt()
    }

    /** After the terminal tab exists, put it in the file pane and start its shell in cwd. */
    function afterTerminalOpen(controller, ctx, sessionId, treePane, cwd, before, attempt) {
      const layout = surfaceOf(controller, sessionId)?.layout
      if (!layout) return
      const created = Object.values(layout.tabs).find(tab => tab.kind === 'terminal' && !before.has(tab.id))
      if (created === undefined) {
        if (attempt >= MAX_RETRIES) return
        queueMicrotask(() => afterTerminalOpen(controller, ctx, sessionId, treePane, cwd, before, attempt + 1))
        return
      }

      const twoPanes = dockPanes(layout).length >= 2
      if (!twoPanes) {
        if (moveTab(controller, sessionId, created.id, treePane, 'left')) {
          const movedLayout = surfaceOf(controller, sessionId)?.layout
          const movedPane = movedLayout ? paneOfTab(movedLayout, created.id) : undefined
          if (movedPane !== undefined && movedPane.id !== treePane) {
            applyDefaultShare(controller, sessionId, treePane, movedPane.id)
          }
        }
      }
      focusTab(controller, created.id)

      const terminals = ctx.get('webTerminals')
      if (!terminals || typeof terminals.view !== 'function') {
        console.warn(`[${TAG}] webTerminals is unavailable; the terminal opens in the Session directory`)
        return
      }
      let view
      try {
        view = terminals.view(sessionId, created.id, created.contentId)
      } catch (error) {
        console.warn(`[${TAG}] terminal view failed`, error)
        return
      }
      sendCdWhenReady(view, cwd)
    }

    /** Open a terminal tab in the file pane (creating the split when only the tree exists). */
    function openTerminalAt(controller, ctx, sessionId, treePane, cwd) {
      if (!ctx.get('webTerminals')) {
        console.warn(`[${TAG}] the terminal bundle is not enabled`)
        return
      }
      const layout = surfaceOf(controller, sessionId)?.layout
      if (!layout) return
      const paneIds = dockPanes(layout)
      const twoPanes = paneIds.length >= 2
      const filePane = twoPanes ? paneIds.find(id => id !== treePane) : treePane
      if (filePane === undefined) return

      const before = new Set(Object.values(layout.tabs).filter(tab => tab.kind === 'terminal').map(tab => tab.id))
      try {
        controller.openTab('terminal', { paneId: filePane })
      } catch (error) {
        console.warn(`[${TAG}] terminal open failed`, error)
        return
      }
      afterTerminalOpen(controller, ctx, sessionId, treePane, cwd, before, 0)
    }

    // --------------------------------------------------------------- chat copy

    /** The bridge publishes the composer actions and current draft text per Session. */
    function InputActionsBridge(props) {
      const input = typeof props.useInput === 'function' ? props.useInput(value => value) : undefined
      const sessionId = props.sessionId
      const inputActions = props.inputActions
      react.useEffect(() => {
        if (sessionId === undefined || inputActions === undefined) return
        chatInputs.set(sessionId, {
          actions: inputActions,
          text: input && typeof input.text === 'string' ? input.text : '',
        })
        return () => {
          const current = chatInputs.get(sessionId)
          if (current !== undefined && current.actions === inputActions) chatInputs.delete(sessionId)
        }
      }, [sessionId, inputActions, input])
      return null
    }

    function copyText(text) {
      try {
        const clipboard = globalThis.navigator?.clipboard
        if (clipboard && typeof clipboard.writeText === 'function') {
          void clipboard.writeText(text).catch(() => {})
          return
        }
      } catch {
        /* fall through to the legacy path */
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        document.execCommand('copy')
        area.remove()
      } catch (error) {
        console.warn(`[${TAG}] copy failed`, error)
      }
    }

    /** The line range starts at one line unless the selection spans more. */
    function lineNumbersOf(selection) {
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return {}
      const lineAt = node => {
        const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node
        if (element === null || element === undefined) return undefined
        const plain = element.closest('[data-textpreview-line]')
        if (plain !== null) return Number(plain.dataset.textpreviewLine)
        const line = element.closest('pre .line')
        if (line !== null) {
          const pre = line.closest('pre')
          const lines = [...pre.querySelectorAll('.line')]
          const index = lines.indexOf(line)
          if (index >= 0) return index + 1
        }
        return undefined
      }
      const range = selection.getRangeAt(0)
      const start = lineAt(range.startContainer)
      const end = lineAt(range.endContainer)
      if (start === undefined || end === undefined) return {}
      return { start: Math.min(start, end), end: Math.max(start, end) }
    }

    /** Workspace-relative where possible; absolute paths stay absolute. */
    function referencePath(sessionId, absolute) {
      const raw = String(absolute).replace(/[\\/]+$/, '')
      const root = typeof document === 'undefined'
        ? undefined
        : document.querySelector(`[data-sidebar-right-session="${cssEscape(sessionId)}"] [data-files-root]`)?.dataset.filesRoot
      if (root === undefined || root === '') return raw
      const normalizedRoot = String(root).replace(/[\\/]+$/, '')
      if (raw === normalizedRoot) return raw
      if (raw.startsWith(`${normalizedRoot}/`)) return raw.slice(normalizedRoot.length + 1)
      if (raw.startsWith(`${normalizedRoot}\\`)) return raw.slice(normalizedRoot.length + 1)
      return raw
    }

    /** The composer's file-reference grammar: quote whitespace, leave other paths bare. */
    function fileMention(path) {
      if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return path
      return /\s/u.test(path) ? `@"${path}"` : `@${path}`
    }

    function languageOf(path) {
      const name = String(path).split(/[\\/]/).pop() ?? ''
      const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
      const languages = {
        bash: 'bash', c: 'c', cc: 'cpp', cpp: 'cpp', css: 'css', csv: 'csv', go: 'go',
        h: 'c', hpp: 'cpp', html: 'html', java: 'java', js: 'js', json: 'json', jsx: 'jsx',
        kt: 'kotlin', kts: 'kotlin', md: 'markdown', mjs: 'js', php: 'php', py: 'python',
        rb: 'ruby', rs: 'rust', scss: 'scss', sh: 'bash', sql: 'sql', swift: 'swift',
        toml: 'toml', ts: 'ts', tsx: 'tsx', xml: 'xml', yaml: 'yaml', yml: 'yaml',
        zsh: 'bash',
      }
      return languages[ext] ?? ''
    }

    function fencedText(text) {
      const runs = String(text).match(/`+/g) ?? []
      const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)))
      return { fence, body: String(text).replace(/\s+$/, '') }
    }

    /** `@path#L12-L20` + a fenced block, inserted at the composer caret. */
    function copyToChat(sessionId, path, text, range) {
      const bridge = chatInputs.get(sessionId)
      const reference = `${fileMention(referencePath(sessionId, path))}`
      const lines = range.start === undefined
        ? ''
        : range.end === undefined || range.end === range.start
          ? `#L${range.start}`
          : `#L${range.start}-L${range.end}`
      const { fence, body } = fencedText(text)
      const language = languageOf(path)
      const payload = `${reference}${lines === '' ? '' : ` ${lines}`}\n${fence}${language}\n${body}\n${fence}\n`
      if (bridge === undefined) {
        console.warn(`[${TAG}] composer bridge is not mounted; copied the reference to the clipboard`)
        copyText(payload)
        return
      }
      try {
        const span = bridge.actions.captureInsertion()
        const prefix = bridge.text.trim() === '' ? '' : bridge.text.endsWith('\n') ? '\n' : '\n\n'
        if (bridge.actions.insertText(`${prefix}${payload}`, span) !== true) {
          console.warn(`[${TAG}] the composer refused the insertion`)
        }
      } catch (error) {
        console.warn(`[${TAG}] composer insertion failed`, error)
      }
    }

    // ---------------------------------------------------------------- preview

    /** Mark the preview tab chip in italic; retries cover the render that follows an open. */
    function markPreview(sessionId, tabId, attempt = 0) {
      if (typeof document === 'undefined') return
      const root = document.querySelector(`[data-sidebar-right-session="${cssEscape(sessionId)}"]`)
      if (root === null) return
      for (const element of root.querySelectorAll('[data-file-pane-preview]')) {
        element.removeAttribute('data-file-pane-preview')
      }
      if (tabId === undefined) return
      const chip = root.querySelector(`[data-dockkit-tab="${cssEscape(tabId)}"]`)
      if (chip !== null) {
        chip.setAttribute('data-file-pane-preview', 'true')
        return
      }
      if (attempt >= MAX_RETRIES) return
      const schedule = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (run) => setTimeout(run, 0)
      schedule(() => markPreview(sessionId, tabId, attempt + 1))
    }

    function setPreview(controller, sessionId, tabId) {
      previewMap(controller).set(sessionId, tabId)
      markPreview(sessionId, tabId)
    }

    function pinPreview(controller, sessionId) {
      const map = previewMap(controller)
      if (!map.has(sessionId)) return
      map.delete(sessionId)
      markPreview(sessionId, undefined)
    }

    /** The preview tab still exists in the pane that is about to receive a replacement? */
    function validPreview(controller, sessionId, filePane) {
      const map = previewMap(controller)
      const tabId = map.get(sessionId)
      if (tabId === undefined) return undefined
      const layout = surfaceOf(controller, sessionId)?.layout
      const pane = layout ? paneOfTab(layout, tabId) : undefined
      if (!pane || pane.id !== filePane) {
        map.delete(sessionId)
        markPreview(sessionId, undefined)
        return undefined
      }
      return tabId
    }

    function activeTabInPane(pane) {
      if (!pane || typeof pane.querySelector !== 'function') return undefined
      const selected = pane.querySelector('[data-dockkit-tab][aria-selected="true"]')
      if (selected !== null) return selected.dataset.dockkitTab
      return pane.querySelector('[data-sidebar-right-tab]')?.dataset.sidebarRightTab
    }

    /** Pin the preview only when it is the tab the double-click just focused or opened. */
    function pinPreviewIfActive(controller, sessionId) {
      if (typeof document === 'undefined') return
      const root = document.querySelector(`[data-sidebar-right-session="${cssEscape(sessionId)}"]`)
      if (root === null) return
      const panes = [...root.querySelectorAll('[data-dockkit-pane]')]
        .filter(pane => pane.getBoundingClientRect().width > 0)
      const filePane = panes.find(pane => pane.querySelector('[data-files-root]') === null)
      const activePane = filePane
        ?? panes.find(pane => pane.hasAttribute('data-dockkit-pane-active'))
        ?? panes[0]
      const active = activeTabInPane(activePane)
      const previewId = previewMap(controller).get(sessionId)
      if (previewId !== undefined && active === previewId) pinPreview(controller, sessionId)
    }

    /**
     * After a new file tab exists: make it the preview, and for the single-pane
     * case split before the tree pane and move it left. Retries cover a store
     * snapshot that lands one microtask after the open.
     */
    function afterOpen(controller, sessionId, treePane, address, shouldSplit, attempt) {
      const surface = surfaceOf(controller, sessionId)
      const layout = surface && surface.layout
      if (!layout) return
      const tab = fileTabIn(layout, address)
      if (tab === undefined) {
        if (attempt >= MAX_RETRIES) return
        queueMicrotask(() => afterOpen(controller, sessionId, treePane, address, shouldSplit, attempt + 1))
        return
      }

      setPreview(controller, sessionId, tab.id)
      if (!shouldSplit) return

      const pane = paneOfTab(layout, tab.id)
      if (!pane || pane.id !== treePane) return
      if (!moveTab(controller, sessionId, tab.id, treePane, 'left')) return

      focusTab(controller, tab.id)
      const movedLayout = surfaceOf(controller, sessionId)?.layout
      const movedPane = movedLayout ? paneOfTab(movedLayout, tab.id) : undefined
      if (movedPane === undefined || movedPane.id === treePane) return
      markPreview(sessionId, tab.id)
      applyDefaultShare(controller, sessionId, treePane, movedPane.id)
    }

    // ------------------------------------------------------------------ patch

    function install(controller, ctx, t) {
      const original = controller && controller.openResourceIn
      if (typeof original !== 'function') return () => {}

      const wrapped = function (sessionId, address, options) {
        if (globalThis.__FILE_PANE_DISABLED__ === true) {
          return original.call(this, sessionId, address, options)
        }
        const debug = globalThis.__FILE_PANE_DEBUG__ === true
        const log = (...args) => { if (debug) console.info(`[${TAG}]`, ...args) }
        const opts = options === undefined || options === null ? {} : options
        if (typeof address !== 'string' || !address.startsWith(FILE_PREFIX)) {
          return original.call(this, sessionId, address, opts)
        }

        const treePane = opts.paneId
        log('open', address, 'pane', treePane)
        if (typeof treePane !== 'string') {
          return original.call(this, sessionId, address, opts)
        }

        const surface = surfaceOf(this, sessionId)
        const layout = surface && surface.layout
        if (!layout) { log('no surface'); return original.call(this, sessionId, address, opts) }

        const treePaneNode = paneOfId(layout, treePane)
        if (!treePaneNode || treePaneNode.host !== 'dock') {
          log('target is not a docked pane', treePaneNode)
          return original.call(this, sessionId, address, opts)
        }
        if (!treeTabIn(layout, treePane)) {
          log('no files tab in target pane')
          return original.call(this, sessionId, address, opts)
        }

        const paneIds = dockPanes(layout)
        const twoPanes = paneIds.length >= 2
        const filePane = twoPanes ? paneIds.find(id => id !== treePane) : treePane
        if (filePane === undefined) return original.call(this, sessionId, address, opts)
        log('dock panes', paneIds, 'file pane', filePane)

        const existing = fileTabIn(layout, address)
        if (existing !== undefined) {
          const existingPane = paneOfTab(layout, existing.id)
          log('existing tab', existing.id, 'in', existingPane && existingPane.id)
          if (twoPanes && existingPane && existingPane.id === treePane) {
            if (moveTab(this, sessionId, existing.id, filePane, 'center')) {
              focusTab(this, existing.id)
              const previewId = previewMap(this).get(sessionId)
              if (previewId !== undefined) markPreview(sessionId, previewId)
            }
            return undefined
          }
          return original.call(this, sessionId, address, {
            ...opts,
            paneId: existingPane && existingPane.id !== undefined ? existingPane.id : filePane,
            preferNewPane: false,
          })
        }

        const previewId = validPreview(this, sessionId, filePane)
        const replace = previewId === undefined ? {} : { replaceTab: previewId }
        log('new file', replace.replaceTab === undefined ? 'as its own preview' : `replacing preview ${previewId}`)
        const result = original.call(this, sessionId, address, {
          ...opts,
          ...replace,
          paneId: filePane,
          preferNewPane: false,
        })
        afterOpen(this, sessionId, treePane, address, !twoPanes, 0)
        return result
      }

      controller.openResourceIn = wrapped

      // ---------------------------------------------------------- context menu
      let menuCleanup = null
      const closeMenu = () => {
        if (menuCleanup === null) return
        const cleanup = menuCleanup
        menuCleanup = null
        cleanup()
      }

      const showMenu = (event, items) => {
        closeMenu()
        const menu = document.createElement('div')
        menu.setAttribute('data-file-pane-menu', '')
        Object.assign(menu.style, {
          position: 'fixed',
          zIndex: '1000',
          minWidth: '180px',
          maxWidth: '380px',
          padding: '4px',
          borderRadius: '10px',
          background: 'var(--dsw-alias-bg-layer-1, #fff)',
          border: '0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))',
          boxShadow: '0 8px 28px rgba(0,0,0,.18)',
          color: 'var(--dsw-alias-label-primary, #111)',
          font: 'inherit',
          fontSize: '13px',
          userSelect: 'none',
        })

        for (const item of items) {
          const button = document.createElement('button')
          button.type = 'button'
          button.setAttribute('role', 'menuitem')
          button.textContent = item.label
          Object.assign(button.style, {
            display: 'block',
            width: '100%',
            boxSizing: 'border-box',
            border: '0',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            fontSize: '13px',
            lineHeight: '20px',
            textAlign: 'left',
            whiteSpace: 'nowrap',
            padding: '7px 10px',
            borderRadius: '6px',
            cursor: 'pointer',
          })
          button.addEventListener('mouseenter', () => {
            button.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06))'
          })
          button.addEventListener('mouseleave', () => {
            button.style.background = 'transparent'
          })
          button.addEventListener('click', clickEvent => {
            clickEvent.preventDefault()
            clickEvent.stopPropagation()
            closeMenu()
            try {
              item.run()
            } catch (error) {
              console.warn(`[${TAG}] menu action failed`, error)
            }
          })
          menu.append(button)
        }

        document.body.appendChild(menu)
        const rect = menu.getBoundingClientRect()
        const left = Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8))
        const top = Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8))
        menu.style.left = `${left}px`
        menu.style.top = `${top}px`

        const onPointerDown = pointerEvent => {
          if (typeof Element === 'undefined') return
          if (!(pointerEvent.target instanceof Element)) return
          if (!menu.contains(pointerEvent.target)) closeMenu()
        }
        const onKeyDown = keyEvent => {
          if (keyEvent.key !== 'Escape') return
          keyEvent.preventDefault()
          closeMenu()
        }
        const onScroll = () => closeMenu()
        const onResize = () => closeMenu()
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onResize)
        menuCleanup = () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onResize)
          menu.remove()
        }
        menu.querySelector('button')?.focus({ preventScroll: true })
      }

      const onContextMenu = event => {
        if (typeof Element === 'undefined' || !(event.target instanceof Element)) return
        const target = event.target
        const sessionId = target.closest('[data-sidebar-right-session]')?.dataset.sidebarRightSession
        if (sessionId === undefined) return

        const root = target.closest('[data-files-root]')
        if (root !== null) {
          const treePaneElement = root.closest('[data-dockkit-pane]')
          const treePane = treePaneElement?.dataset.dockkitPane
          if (treePane === undefined) return
          const button = target.closest('button')
          const row = button !== null && button.parentElement?.hasAttribute('data-files-entry')
            ? button.parentElement
            : null
          let cwd
          if (row !== null) {
            const path = row.dataset.filesPath
            if (path === undefined || path === '') return
            cwd = row.dataset.filesEntry === 'directory' ? path : parentPath(path)
          } else {
            cwd = root.dataset.filesRoot
          }
          if (cwd === undefined || cwd === '') return
          event.preventDefault()
          event.stopPropagation()
          showMenu(event, [{
            label: t('openTerminal'),
            run: () => openTerminalAt(controller, ctx, sessionId, treePane, cwd),
          }])
          return
        }

        // Text selected in a file pane (the pane without the Workspace files tree).
        const pane = target.closest('[data-dockkit-pane]')
        if (pane === null || pane.querySelector('[data-files-root]') !== null) return
        const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
        if (selection === null || selection === undefined || selection.isCollapsed || selection.rangeCount === 0) return
        const text = selection.toString()
        if (text.trim() === '') return
        const pathElement = pane.querySelector('[data-textpreview-path]')
        if (pathElement === null) return
        if (pathElement.contains(selection.anchorNode) || pathElement.contains(selection.focusNode)) return
        const path = pathElement.getAttribute('title') ?? pathElement.textContent ?? ''
        if (path === '') return
        event.preventDefault()
        event.stopPropagation()
        const lineRange = lineNumbersOf(selection)
        showMenu(event, [
          { label: t('copy'), run: () => copyText(text) },
          { label: t('copyToChat'), run: () => copyToChat(sessionId, path, text, lineRange) },
        ])
      }

      const onDoubleClick = event => {
        if (typeof Element === 'undefined' || !(event.target instanceof Element)) return
        const target = event.target
        const row = target.closest('[data-files-entry="file"]')
        if (row !== null) {
          const sessionId = row.closest('[data-sidebar-right-session]')?.dataset.sidebarRightSession
          if (sessionId !== undefined) pinPreviewIfActive(controller, sessionId)
          return
        }
        const chip = target.closest('[data-dockkit-tab], [data-sidebar-right-tab]')
        if (chip !== null) {
          const tabId = chip.dataset.dockkitTab ?? chip.dataset.sidebarRightTab
          const sessionId = chip.closest('[data-sidebar-right-session]')?.dataset.sidebarRightSession
          if (sessionId !== undefined && tabId !== undefined && previewMap(controller).get(sessionId) === tabId) {
            pinPreview(controller, sessionId)
          }
        }
      }

      let style
      if (typeof document !== 'undefined') {
        document.addEventListener('dblclick', onDoubleClick, true)
        document.addEventListener('contextmenu', onContextMenu, true)
        document.querySelectorAll('style[data-file-pane]').forEach(element => element.remove())
        style = document.createElement('style')
        style.setAttribute('data-file-pane', '')
        style.textContent = '[data-dockkit-tab][data-file-pane-preview="true"]{font-style:italic}'
        document.head.appendChild(style)
      }

      console.info(`[${TAG}] installed: workspace files open in the left pane`)
      return () => {
        if (controller.openResourceIn === wrapped) controller.openResourceIn = original
        if (typeof document !== 'undefined') {
          document.removeEventListener('dblclick', onDoubleClick, true)
          document.removeEventListener('contextmenu', onContextMenu, true)
          closeMenu()
          document.querySelectorAll('[data-file-pane-preview]').forEach(element => {
            element.removeAttribute('data-file-pane-preview')
          })
        }
        if (style !== undefined) style.remove()
        previewMap(controller).clear()
        console.info(`[${TAG}] disposed`)
      }
    }

    return {
      inject: ['sidebarRight', 'locale', 'slots'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'file-pane: copy')
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'file-pane-chat-bridge',
          order: 1000,
        }, InputActionsBridge)), 'file-pane: composer bridge')
        ctx.effect(() => {
          const controller = ctx.sidebarRight
          if (!controller) return
          return install(controller, ctx, t)
        }, 'file-pane: workspace files in the left pane')
      },
      // Test-only handles; the loader ignores extra exports.
      __test: {
        install,
        previewOf: (controller, sessionId) => previewMap(controller).get(sessionId),
        pin: (controller, sessionId) => pinPreview(controller, sessionId),
        parentPath,
        terminalCdCommand,
        terminalInitCommand,
      },
    }
  },
})
