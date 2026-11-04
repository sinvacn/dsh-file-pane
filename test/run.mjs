import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const FILE_A = 'dsh-resource://file/session/s1/README.md'
const FILE_B = 'dsh-resource://file/session/s1/src/app.ts'
const FILE_C = 'dsh-resource://file/session/s1/src/other.ts'

/** localStorage stub shared by the VM and the tests. */
const storage = {
  value: null,
  getItem(key) {
    return key === 'dsh.file-pane.share' ? this.value : null
  },
}

/** The dockkit face the plugin consumes, backed by the harness layout shape. */
const dockkit = {
  dockPaneIds: layout => layout.panes.slice(),
  findTabPane(layout, tabId) {
    const id = layout.paneOf[tabId]
    return id === undefined ? undefined : { id, host: 'dock' }
  },
  getPane(layout, paneId) {
    return layout.panes.includes(paneId) ? { id: paneId, host: 'dock' } : undefined
  },
}

/** Minimal controller: an adopted store, a recording open, and the public focus. */
function createHarness({ panes, tabs, treePane }) {
  const layout = { panes: [...panes], tabs: {}, paneOf: {}, nodes: {} }
  for (const tab of tabs) {
    layout.tabs[tab.id] = { ...tab }
    layout.paneOf[tab.id] = tab.paneId ?? treePane
  }

  let sequence = 0
  const calls = { open: [], drop: [], focus: [], resize: [], openResource: [] }

  const store = {
    getSnapshot: () => ({ bySession: { s1: { layout } } }),
    actions: {
      dropTab(sessionId, tabId, paneId, zone) {
        calls.drop.push({ sessionId, tabId, paneId, zone })
        if (!layout.panes.includes(paneId)) throw new Error(`dropTab: unknown pane ${paneId}`)
        if (zone === 'center') {
          layout.paneOf[tabId] = paneId
          return
        }
        if (zone !== 'left') throw new Error(`dropTab: unexpected zone ${zone}`)
        const newPane = `left-${++sequence}`
        const splitId = `split-${++sequence}`
        layout.panes.splice(layout.panes.indexOf(paneId), 0, newPane)
        layout.paneOf[tabId] = newPane
        layout.nodes[splitId] = { kind: 'split', id: splitId, children: [newPane, paneId], sizes: [0.5, 0.5] }
        layout.rootId = splitId
      },
      resizeSplit(sessionId, splitId, sizes) {
        calls.resize.push({ sessionId, splitId, sizes: [...sizes] })
        const split = layout.nodes[splitId]
        if (split !== undefined) split.sizes = [...sizes]
      },
    },
  }

  const controller = {
    adopted: new Map([['s1', { store }]]),
    openResource(address, options = {}) {
      calls.openResource.push({ address, options })
    },
    openResourceIn(sessionId, address, options = {}) {
      calls.open.push({ sessionId, address, options })
      const existing = Object.values(layout.tabs).find(tab => tab.contentId === address)
      if (existing !== undefined) {
        calls.focus.push(existing.id)
        return
      }
      if (options.replaceTab !== undefined) {
        delete layout.tabs[options.replaceTab]
        delete layout.paneOf[options.replaceTab]
      }
      const id = `file-${++sequence}`
      const paneId = options.paneId ?? layout.panes[0]
      if (!layout.panes.includes(paneId)) throw new Error(`open: unknown pane ${paneId}`)
      layout.tabs[id] = { id, kind: 'text', contentId: address, title: 'file' }
      layout.paneOf[id] = paneId
      calls.focus.push(id)
    },
    focus(tabId) {
      calls.focus.push(tabId)
    },
  }

  return { layout, calls, controller }
}

/** Load the real client bundle in a VM and return its plugin definition. */
function loadPlugin() {
  const source = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')
  let definition
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: value => { definition = value } } },
    queueMicrotask,
    console,
    localStorage: storage,
  })
  if (definition === undefined) throw new Error('client.js did not register a module')
  return definition.factory(name => {
    if (name === '@deepseek-ai/dsh-client-ui-dockkit') return dockkit
    if (name === 'react') return { useEffect: () => {}, createElement: () => null }
    throw new Error(`unexpected require: ${name}`)
  })
}

const plugin = loadPlugin()
assert.ok(plugin.inject.includes('sidebarRight'))
assert.ok(plugin.inject.includes('slots'))
assert.equal(typeof plugin.apply, 'function')
assert.equal(typeof plugin.__test.pin, 'function')

/** Install the plugin on one fake controller and return the disposer. */
function mount(controller) {
  let dispose = () => {}
  plugin.apply({
    sidebarRight: controller,
    locale: {
      register: () => () => {},
      bind: () => key => key,
    },
    slots: {
      inject: () => () => {},
      register: () => () => {},
    },
    effect(fn) {
      dispose = fn()
      return dispose
    },
  })
  return dispose
}

const tick = () => new Promise(resolve => queueMicrotask(resolve))

const treeTab = id => ({ id, kind: 'files', contentId: 'page:files', title: 'Workspace files' })
const fileTab = (id, contentId, paneId) => ({ id, kind: 'text', contentId, title: 'file', paneId })

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('one pane: opens the file to the left, 70/30, and makes it the preview', async () => {
  storage.value = null
  const harness = createHarness({
    panes: ['p1'],
    tabs: [treeTab('tree')],
    treePane: 'p1',
  })
  const dispose = mount(harness.controller)
  try {
    harness.controller.openResourceIn('s1', FILE_A, { paneId: 'p1' })
    await tick()
    assert.equal(harness.calls.open.length, 1)
    assert.equal(harness.calls.open[0].options.paneId, 'p1')
    assert.equal(harness.calls.open[0].options.preferNewPane, false)
    assert.equal(harness.layout.panes.length, 2)
    assert.notEqual(harness.layout.panes[0], 'p1')
    assert.equal(harness.layout.panes[1], 'p1')
    const file = Object.values(harness.layout.tabs).find(tab => tab.contentId === FILE_A)
    assert.ok(file)
    assert.equal(harness.layout.paneOf[file.id], harness.layout.panes[0])
    assert.equal(plugin.__test.previewOf(harness.controller, 's1'), file.id)
    assert.deepEqual(harness.calls.resize.map(call => call.sizes), [[0.7, 0.3]])
    assert.deepEqual(
      harness.calls.drop.map(call => [call.tabId, call.paneId, call.zone]),
      [[file.id, 'p1', 'left']],
    )
  } finally {
    dispose()
  }
})

test('single-click replaces the preview tab instead of adding another', async () => {
  storage.value = null
  const harness = createHarness({
    panes: ['p1'],
    tabs: [treeTab('tree')],
    treePane: 'p1',
  })
  const dispose = mount(harness.controller)
  try {
    harness.controller.openResourceIn('s1', FILE_A, { paneId: 'p1' })
    await tick()
    const first = Object.values(harness.layout.tabs).find(tab => tab.contentId === FILE_A)
    harness.controller.openResourceIn('s1', FILE_B, { paneId: 'p1' })
    await tick()
    assert.equal(harness.calls.open[1].options.replaceTab, first.id)
    assert.equal(harness.layout.tabs[first.id], undefined, 'the old preview is gone')
    const second = Object.values(harness.layout.tabs).find(tab => tab.contentId === FILE_B)
    assert.ok(second)
    assert.equal(plugin.__test.previewOf(harness.controller, 's1'), second.id)
    const files = Object.values(harness.layout.tabs).filter(tab => tab.kind === 'text')
    assert.equal(files.length, 1, 'only one preview file tab remains')
    assert.equal(harness.calls.resize.length, 1, 'the existing split is not resized again')
  } finally {
    dispose()
  }
})

test('pinning the preview makes the next single-click open a new tab', async () => {
  storage.value = null
  const harness = createHarness({
    panes: ['p1'],
    tabs: [treeTab('tree')],
    treePane: 'p1',
  })
  const dispose = mount(harness.controller)
  try {
    harness.controller.openResourceIn('s1', FILE_A, { paneId: 'p1' })
    await tick()
    const first = Object.values(harness.layout.tabs).find(tab => tab.contentId === FILE_A)
    plugin.__test.pin(harness.controller, 's1')
    assert.equal(plugin.__test.previewOf(harness.controller, 's1'), undefined)
    harness.controller.openResourceIn('s1', FILE_B, { paneId: 'p1' })
    await tick()
    assert.equal(harness.calls.open[1].options.replaceTab, undefined)
    const second = Object.values(harness.layout.tabs).find(tab => tab.contentId === FILE_B)
    assert.ok(second)
    assert.ok(harness.layout.tabs[first.id], 'the pinned tab remains')
    assert.equal(plugin.__test.previewOf(harness.controller, 's1'), second.id)
    const files = Object.values(harness.layout.tabs).filter(tab => tab.kind === 'text')
    assert.equal(files.length, 2, 'pinned tab + new preview')
  } finally {
    dispose()
  }
})

test('a pinned file opened again is focused, not turned into a preview', async () => {
  storage.value = null
  const harness = createHarness({
    panes: ['p1'],
    tabs: [treeTab('tree')],
    treePane: 'p1',
  })
  const dispose = mount(harness.controller)
  try {
    harness.controller.openResourceIn('s1', FILE_A, { paneId: 'p1' })
    await tick()
    plugin.__test.pin(harness.controller, 's1')
    const before = harness.calls.open.length
    harness.controller.openResourceIn('s1', FILE_A, { paneId: 'p1' })
    await tick()
    assert.equal(harness.calls.open.length, before + 1)
    assert.equal(plugin.__test.previewOf(harness.controller, 's1'), undefined)
    const files = Object.values(harness.layout.tabs).filter(tab => tab.kind === 'text')
    assert.equal(files.length, 1)
  } finally {
    dispose()
  }
})

test('two panes: single-click replaces the preview in the sibling pane', async () => {
  storage.value = null
  const harness = createHarness({
    panes: ['p1', 'p2'],
    tabs: [treeTab('tree')],
    treePane: 'p2',
  })
  const dispose = mount(harness.controller)
  try {
    harness.controller.openResourceIn('s1', FILE_A, { paneId: 'p2' })
    await tick()
    const first = Object.values(harness.layout.tabs).find(tab => tab.contentId === FILE_A)
    assert.equal(harness.calls.open[0].options.paneId, 'p1')
    assert.equal(harness.calls.drop.length, 0)
    harness.controller.openResourceIn('s1', FILE_B, { paneId: 'p2' })
    await tick()
    assert.equal(harness.calls.open[1].options.replaceTab, first.id)
    assert.equal(harness.layout.tabs[first.id], undefined)
    const second = Object.values(harness.layout.tabs).find(tab => tab.contentId === FILE_B)
    assert.ok(second)
    assert.equal(harness.layout.paneOf[second.id], 'p1')
    assert.equal(harness.layout.paneOf[harness.layout.tabs.tree.id], 'p2')
    assert.equal(plugin.__test.previewOf(harness.controller, 's1'), second.id)
  } finally {
    dispose()
  }
})

test('non-file resources are untouched', async () => {
  storage.value = null
  const harness = createHarness({
    panes: ['p1'],
    tabs: [treeTab('tree')],
    treePane: 'p1',
  })
  const dispose = mount(harness.controller)
  try {
    harness.controller.openResourceIn('s1', 'dsh-resource://other/x', { paneId: 'p1' })
    await tick()
    assert.equal(harness.calls.open.length, 1)
    assert.equal(harness.calls.open[0].options.paneId, 'p1')
    assert.equal(harness.calls.drop.length, 0)
    assert.equal(plugin.__test.previewOf(harness.controller, 's1'), undefined)
  } finally {
    dispose()
  }
})

test('file opens from a pane without a files tree are untouched', async () => {
  storage.value = null
  const harness = createHarness({
    panes: ['p1', 'p2'],
    tabs: [treeTab('tree')],
    treePane: 'p1',
  })
  const dispose = mount(harness.controller)
  try {
    harness.controller.openResourceIn('s1', FILE_A, { paneId: 'p2' })
    await tick()
    assert.equal(harness.calls.open.length, 1)
    assert.equal(harness.calls.open[0].options.paneId, 'p2')
    assert.equal(harness.calls.drop.length, 0)
    assert.equal(plugin.__test.previewOf(harness.controller, 's1'), undefined)
  } finally {
    dispose()
  }
})

test('terminal paths and cd commands follow the shell', () => {
  assert.equal(plugin.__test.parentPath('/Users/sinva/workspace/a/file.ts'), '/Users/sinva/workspace/a')
  assert.equal(plugin.__test.parentPath('/file.ts'), '/')
  assert.equal(plugin.__test.parentPath('C:\\work\\file.ts'), 'C:\\work')
  assert.equal(plugin.__test.terminalCdCommand({ name: 'zsh', path: '/bin/zsh' }, "/tmp/it's here"), "cd '/tmp/it'\\''s here'")
  assert.equal(plugin.__test.terminalCdCommand({ name: 'pwsh', path: '/usr/local/bin/pwsh' }, "C:\\it's"), "Set-Location -LiteralPath 'C:\\it''s'")
  assert.equal(plugin.__test.terminalCdCommand({ name: 'cmd', path: 'C:\\Windows\\cmd.exe' }, 'C:\\work'), 'cd /d "C:\\work"')
  assert.equal(plugin.__test.terminalInitCommand({ name: 'zsh', path: '/bin/zsh' }, '/tmp/x'), "cd '/tmp/x' && clear")
  assert.equal(plugin.__test.terminalInitCommand({ name: 'pwsh', path: '/usr/local/bin/pwsh' }, '/tmp/x'), "Set-Location -LiteralPath '/tmp/x'; Clear-Host")
  assert.equal(plugin.__test.terminalInitCommand({ name: 'cmd', path: 'C:\\Windows\\cmd.exe' }, 'C:\\work'), 'cd /d "C:\\work" && cls')
})

test('copy paths: relative to the workspace root, absolute otherwise', () => {
  const relative = plugin.__test.relativePath
  assert.equal(relative('/Users/sinva/project', '/Users/sinva/project/src/app.ts'), 'src/app.ts')
  assert.equal(relative('/Users/sinva/project', '/Users/sinva/project/src'), 'src')
  assert.equal(relative('/Users/sinva/project', '/Users/sinva/project/src/'), 'src', 'trailing separator is dropped')
  assert.equal(relative('/Users/sinva/project/', '/Users/sinva/project/src/app.ts'), 'src/app.ts', 'root may end in a separator')
  assert.equal(relative('/Users/sinva/project', '/Users/sinva/project'), '.', 'the root itself is .')
  assert.equal(relative('/Users/sinva/project', '/Users/sinva/project2/app.ts'), '/Users/sinva/project2/app.ts', 'a sibling prefix is not relative')
  assert.equal(relative('/Users/sinva/project', '/tmp/app.ts'), '/tmp/app.ts', 'outside the workspace stays absolute')
  assert.equal(relative('C:\\work', 'C:\\work\\src\\app.ts'), 'src\\app.ts', 'Windows separators')
  assert.equal(relative(undefined, '/tmp/app.ts'), '/tmp/app.ts', 'no root falls back to absolute')
})

test('a :line suffix opens the bare file and asks the preview for that line', async () => {
  storage.value = null
  const harness = createHarness({
    panes: ['p1'],
    tabs: [treeTab('tree')],
    treePane: 'p1',
  })
  const dispose = mount(harness.controller)
  try {
    harness.controller.openResource(`${FILE_A}:100`)
    assert.equal(harness.calls.openResource.length, 1)
    assert.equal(harness.calls.openResource[0].address, FILE_A)
    assert.equal(harness.calls.openResource[0].options.params.line, 100)

    harness.controller.openResourceIn('s1', `${FILE_B}:12-20`, { paneId: 'p1' })
    await tick()
    assert.equal(harness.calls.open[0].address, FILE_B)
    assert.equal(harness.calls.open[0].options.params.line, 12)
  } finally {
    dispose()
  }
})

test('line suffix parsing keeps existing params and file paths intact', () => {
  const target = plugin.__test.withLineTarget
  const whole = target(`${FILE_A}:42`)
  assert.equal(whole.address, FILE_A)
  assert.equal(whole.options.params.line, 42)
  assert.equal(target(`${FILE_A}:42-60`).options.params.line, 42, 'a range starts at its first line')
  assert.equal(target(`${FILE_A}:42:7`).options.params.line, 42, 'column is ignored')
  const merged = target(`${FILE_A}:42`, { paneId: 'p1', params: { reveal: true } })
  assert.equal(merged.options.paneId, 'p1')
  assert.equal(merged.options.params.reveal, true)
  assert.equal(merged.options.params.line, 42)
  const plain = target(FILE_A)
  assert.equal(plain.address, FILE_A, 'no suffix is a no-op')
  assert.deepEqual(Object.keys(plain.options), [], 'no options are invented')
  assert.equal(target(`${FILE_A}:0`).address, `${FILE_A}:0`, 'lines start at 1')
  assert.equal(target(`${FILE_A}:42x`).address, `${FILE_A}:42x`, 'only a complete suffix counts')
  assert.equal(target(`${FILE_A}?q=:42`).address, `${FILE_A}?q=:42`, 'query suffixes are left alone')
  assert.equal(target('dsh-resource://page/files:42').address, 'dsh-resource://page/files:42', 'non-file addresses are untouched')
})


test('the default split share is configurable and clamped to 20-80%', async () => {
  const cases = [['0.65', [0.65, 0.35]], ['0.7', [0.7, 0.3]], ['0.95', [0.8, 0.2]], ['0.1', [0.2, 0.8]]]
  for (const [value, expected] of cases) {
    storage.value = value
    const harness = createHarness({
      panes: ['p1'],
      tabs: [treeTab('tree')],
      treePane: 'p1',
    })
    const dispose = mount(harness.controller)
    try {
      harness.controller.openResourceIn('s1', FILE_A, { paneId: 'p1' })
      await tick()
      assert.deepEqual(harness.calls.resize.map(call => call.sizes), [expected], `share ${value}`)
    } finally {
      dispose()
    }
  }
  storage.value = null
})

test('disposing restores the original open method and clears preview state', async () => {
  storage.value = null
  const harness = createHarness({
    panes: ['p1'],
    tabs: [treeTab('tree')],
    treePane: 'p1',
  })
  const original = harness.controller.openResourceIn
  const originalOpenResource = harness.controller.openResource
  const dispose = mount(harness.controller)
  harness.controller.openResourceIn('s1', FILE_A, { paneId: 'p1' })
  await tick()
  assert.notEqual(harness.controller.openResourceIn, original)
  assert.notEqual(harness.controller.openResource, originalOpenResource)
  dispose()
  assert.equal(harness.controller.openResourceIn, original)
  assert.equal(harness.controller.openResource, originalOpenResource)
  assert.equal(plugin.__test.previewOf(harness.controller, 's1'), undefined)
  harness.controller.openResourceIn('s1', FILE_B, { paneId: 'p1' })
  await tick()
  assert.equal(harness.calls.drop.length, 1, 'only the first open was intercepted')
})

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${tests.length} tests failed`)
  process.exitCode = 1
} else {
  console.log(`\n${tests.length}/${tests.length} tests passed`)
}
