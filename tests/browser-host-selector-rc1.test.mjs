import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {
  HOST_INVENTORY_PATH,
  HOST_SELECTOR_ROOT_ID,
  hostSelectorBootstrap,
  registerHostInventory
} from '../packages/browser-host-hub-rc1/src/host-selector.js'

function fakeResponse() {
  return {
    status: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body = '') { this.body += body }
  }
}

class DomElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.parentNode = undefined
    this.attributes = new Map()
    this.listeners = new Map()
    this.id = ''
    this.value = ''
    this.textContent = ''
    this.style = {}
  }

  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = undefined
    return child
  }

  get firstChild() { return this.children[0] }

  setAttribute(name, value) { this.attributes.set(name, String(value)) }

  getAttribute(name) { return this.attributes.get(name) ?? null }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) ?? []) listener.call(this, event)
    return true
  }

  get options() { return this.children.filter(child => child.tagName === 'OPTION') }

  querySelector(selector) {
    const match = /^option\[value="(.*)"\]$/.exec(selector)
    if (!match) return undefined
    return this.options.find(option => option.value === match[1])
  }
}

class DomDocument {
  constructor() {
    this.readyState = 'complete'
    this.listeners = new Map()
    this.documentElement = new DomElement('html')
    this.head = new DomElement('head')
    this.body = new DomElement('body')
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
  }

  createElement(tagName) { return new DomElement(tagName) }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  getElementById(id) {
    const visit = node => {
      if (node.id === id) return node
      for (const child of node.children) {
        const found = visit(child)
        if (found) return found
      }
      return undefined
    }
    return visit(this.documentElement)
  }
}

test('Host inventory is authenticated, read-only, local-first, and disposable', async () => {
  const registered = []
  let authCalls = 0
  let carrierCalls = 0
  const local = { label: 'This device', call() { carrierCalls++ }, open() { carrierCalls++ } }
  const remote = { carrier: { call() { carrierCalls++ }, open() { carrierCalls++ } }, alias: 'Ubuntu' }
  const ctx = {
    webServer: { register(route) { registered.push(route); return () => { route.removed = true } } },
    authorizeRequest() { authCalls++; return undefined }
  }
  const dispose = registerHostInventory(ctx, new Map([['remote-1', remote], ['local', local]]))
  assert.equal(registered.length, 1)
  assert.equal(registered[0].path, HOST_INVENTORY_PATH)
  const response = fakeResponse()
  await registered[0].handler({ method: 'GET' }, response)
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { hosts: [
    { hostId: 'local', label: 'This device', state: 'offline' },
    { hostId: 'remote-1', label: 'Ubuntu', state: 'offline' }
  ] })
  assert.equal(authCalls, 1)
  assert.equal(carrierCalls, 0)
  const unauthorized = fakeResponse()
  ctx.authorizeRequest = () => 401
  await registered[0].handler({ method: 'GET' }, unauthorized)
  assert.equal(unauthorized.status, 401)
  const method = fakeResponse()
  ctx.authorizeRequest = () => undefined
  await registered[0].handler({ method: 'POST' }, method)
  assert.equal(method.status, 405)
  dispose()
  assert.equal(registered[0].removed, true)
})

test('Host inventory exposes carrier phase and configured label without dialing', async () => {
  const registered = []
  let carrierCalls = 0
  const local = {
    label: '本机',
    getState: () => ({ phase: 'connected' }),
    call() { carrierCalls++ },
    open() { carrierCalls++ }
  }
  const remote = {
    label: 'Ubuntu Dell',
    getState: () => ({ phase: 'connecting' }),
    call() { carrierCalls++ },
    open() { carrierCalls++ }
  }
  const ctx = {
    webServer: { register(route) { registered.push(route); return () => {} } },
    authorizeRequest() { return undefined }
  }
  registerHostInventory(ctx, new Map([['remote-1', remote], ['local', local]]))
  const response = fakeResponse()
  await registered[0].handler({ method: 'GET' }, response)
  assert.deepEqual(JSON.parse(response.body), { hosts: [
    { hostId: 'local', label: '本机', state: 'connected' },
    { hostId: 'remote-1', label: 'Ubuntu Dell', state: 'connecting' }
  ] })
  assert.equal(carrierCalls, 0)
})

test('Host selector paths cannot become cross-origin or traversal URLs', () => {
  assert.throws(() => hostSelectorBootstrap({ inventoryPath: '//evil.test/hosts' }), /absolute path/)
  assert.throws(() => hostSelectorBootstrap({ inventoryPath: '/api/../hosts' }), /absolute path/)
})

test('Host selector bootstrap renders a real DOM control and only changes the selected Host', async () => {
  const document = new DomDocument()
  const selections = []
  const sandbox = {
    document,
    console,
    Promise,
    setTimeout,
    clearTimeout,
    fetch: async () => { throw new Error('selector must not fetch inventory') },
    __DSH_BROWSER_HOST_HUB__: {
      getHosts: () => [
        { hostId: 'ubuntu', label: 'Ubuntu' },
        { hostId: 'local', label: 'Local machine' }
      ],
      getSelectedHost: () => undefined,
      setSelectedHost(hostId) { selections.push(hostId); return hostId }
    }
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(hostSelectorBootstrap(), sandbox)
  await new Promise(resolve => setTimeout(resolve, 0))
  const root = document.getElementById(HOST_SELECTOR_ROOT_ID)
  assert.ok(root)
  assert.equal(root.tagName, 'SECTION')
  assert.equal(root.getAttribute('data-dsh-host-selector'), '')
  assert.match(root.getAttribute('aria-label'), /new projects/)
  assert.match(root.getAttribute('title'), /resource ID/)
  const select = root.children.find(child => child.tagName === 'SELECT')
  assert.ok(select)
  assert.deepEqual(select.options.map(option => option.value), ['local', 'ubuntu'])
  assert.equal(select.value, 'local')
  assert.deepEqual(selections.at(-1), 'local')
  const style = document.head.children.find(child => child.tagName === 'STYLE')
  assert.ok(style)
  assert.match(style.textContent, /--dsw-alias-bg-layer-1/)
  select.value = 'ubuntu'
  select.dispatchEvent({ type: 'change' })
  assert.deepEqual(selections.at(-1), 'ubuntu')
  assert.equal(selections.includes('disconnect'), false)
  vm.runInNewContext(hostSelectorBootstrap(), sandbox)
  assert.equal(document.body.children.filter(child => child.id === HOST_SELECTOR_ROOT_ID).length, 1)
})

test('Host selector bootstrap preserves an existing page-local Host selection', async () => {
  const document = new DomDocument()
  const selections = []
  const sandbox = {
    document,
    Promise,
    setTimeout,
    fetch: async () => { throw new Error('selector must not fetch inventory') },
    __DSH_BROWSER_HOST_HUB__: {
      getHosts: () => [
        { hostId: 'ubuntu', label: 'Ubuntu' },
        { hostId: 'local', label: 'Local machine' }
      ],
      getSelectedHost: () => 'ubuntu',
      setSelectedHost(hostId) { selections.push(hostId); return hostId }
    }
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(hostSelectorBootstrap(), sandbox)
  await new Promise(resolve => setTimeout(resolve, 0))
  const select = document.getElementById(HOST_SELECTOR_ROOT_ID).children.find(child => child.tagName === 'SELECT')
  assert.equal(select.value, 'ubuntu')
  assert.deepEqual(selections, [])
})
