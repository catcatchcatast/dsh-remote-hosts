import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import store from '../packages/mobile-bootstrap-rc1/src/bootstrap-store.cjs'

test('protected bootstrap preserves instance ownership and rejects stale records', () => {
  const base = path.resolve('build/bootstrap-test')
  fs.mkdirSync(base, { recursive: true })
  const home = fs.mkdtempSync(path.join(base, 'home-'))
  try {
    const first = store.publishBootstrap(3081, 'http://127.0.0.1:3081/?token=test-one', home)
    const initial = store.readBootstrap(3081, home)
    assert.equal(initial.authenticatedRootUrl, 'http://127.0.0.1:3081/?token=test-one')
    assert.equal(initial.pid, process.pid)
    const second = store.publishBootstrap(3081, 'http://127.0.0.1:3081/?token=test-two', home)
    first()
    assert.equal(store.readBootstrap(3081, home).authenticatedRootUrl, 'http://127.0.0.1:3081/?token=test-two')
    const file = path.join(home, '.dsh-mobile/bootstrap-3081.json')
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...record, processStamp: 'stale' }))
    assert.throws(() => store.readBootstrap(3081, home), /STALE_INSTANCE/)
    second()
    assert.equal(fs.existsSync(file), false)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('rejects invalid ports and off-origin startup URLs before writing', () => {
  for (const port of [0, 65536, '3081;echo', '1.2', -1]) assert.throws(() => store.portNumber(port))
  for (const url of ['https://127.0.0.1:3081/?token=x', 'http://example.com:3081/?token=x', 'http://127.0.0.1:3082/?token=x', 'http://127.0.0.1:3081/api/?token=x', 'http://127.0.0.1:3081/?token=x&token=y']) {
    assert.throws(() => store.publishBootstrap(3081, url), /INVALID_URL/)
  }
})

test('Windows bootstrap repairs an owner-controlled directory with an unexpected inherited reader', { skip: process.platform !== 'win32' }, () => {
  const base = path.resolve('build/bootstrap-test')
  fs.mkdirSync(base, { recursive: true })
  const home = fs.mkdtempSync(path.join(base, 'home-acl-'))
  try {
    const disposeFirst = store.publishBootstrap(3081, 'http://127.0.0.1:3081/?token=test-one', home)
    const directory = path.join(home, '.dsh-mobile')
    execFileSync('icacls.exe', [directory, '/grant', '*S-1-5-32-545:(OI)(CI)(RX)'], { windowsHide: true })

    const disposeSecond = store.publishBootstrap(3081, 'http://127.0.0.1:3081/?token=test-two', home)
    assert.equal(store.readBootstrap(3081, home).authenticatedRootUrl, 'http://127.0.0.1:3081/?token=test-two')
    const acl = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$a=(Get-Item -LiteralPath $env:DSH_BOOT_PATH -Force).GetAccessControl(); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; @($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin @($sid,'S-1-5-18')}).Count",
    ], { encoding: 'utf8', windowsHide: true, env: { ...process.env, DSH_BOOT_PATH: directory } }).trim()
    assert.equal(acl, '0')
    disposeFirst()
    disposeSecond()
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})
