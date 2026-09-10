'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')

const LIMIT = 4096
function portNumber(value) {
  if (!/^\d{1,5}$/.test(String(value)) || +value < 1 || +value > 65535) throw new Error('BOOTSTRAP_INVALID_PORT')
  return +value
}
function ps(script, env = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 8192,
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
function processStamp(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('BOOTSTRAP_INVALID_PROCESS')
  if (process.platform === 'win32') return ps('(Get-Process -Id ([int]$env:DSH_BOOT_PID) -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()', { DSH_BOOT_PID: String(pid) })
  if (process.platform === 'linux') {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  }
  return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000 }).trim()
}
function assertOwner(target, directory = false) {
  const st = fs.lstatSync(target)
  if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile())) throw new Error('BOOTSTRAP_UNSAFE_PATH')
  if (process.platform !== 'win32') {
    if (st.uid !== process.getuid() || (st.mode & 0o077) !== 0) throw new Error('BOOTSTRAP_UNSAFE_PERMISSIONS')
    return
  }
  const result = ps(`$ErrorActionPreference='Stop'; $p=$env:DSH_BOOT_PATH; $i=Get-Item -LiteralPath $p -Force; if(($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'path'}; $a=$i.GetAccessControl(); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'owner'}; foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin @($sid.Value,'S-1-5-18')){throw 'acl'}}; 'ok'`, { DSH_BOOT_PATH: target })
  if (result !== 'ok') throw new Error('BOOTSTRAP_UNSAFE_PERMISSIONS')
}
function hardenWindowsAcl(target, directory = false) {
  const st = fs.lstatSync(target)
  if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile())) throw new Error('BOOTSTRAP_UNSAFE_PATH')
  const securityType = directory ? 'DirectorySecurity' : 'FileSecurity'
  const inheritance = directory ? 'ContainerInherit,ObjectInherit' : 'None'
  const result = ps(`$ErrorActionPreference='Stop'; $p=$env:DSH_BOOT_PATH; $i=Get-Item -LiteralPath $p -Force; if(($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'path'}; $old=$i.GetAccessControl(); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; if($old.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'owner'}; $a=New-Object Security.AccessControl.${securityType}; $a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false); foreach($id in @($sid.Value,'S-1-5-18')){$r=New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]$id,'FullControl','${inheritance}','None','Allow'); $a.AddAccessRule($r)}; $i.SetAccessControl($a); 'ok'`, { DSH_BOOT_PATH: target })
  if (result !== 'ok') throw new Error('BOOTSTRAP_UNSAFE_PERMISSIONS')
  assertOwner(target, directory)
}
function ensureDirectory(home) {
  const dir = path.join(home, '.dsh-mobile')
  if (fs.existsSync(dir)) {
    if (process.platform === 'win32') hardenWindowsAcl(dir, true)
    else assertOwner(dir, true)
    return dir
  }
  if (process.platform === 'win32') {
    // Directory contains no secrets until its protected ACL has been installed.
    ps(`$ErrorActionPreference='Stop'; $p=$env:DSH_BOOT_PATH; $s=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object Security.AccessControl.DirectorySecurity; $a.SetOwner($s); $a.SetAccessRuleProtection($true,$false); foreach($id in @($s.Value,'S-1-5-18')){$r=New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]$id,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $a.AddAccessRule($r)}; [IO.Directory]::CreateDirectory($p,$a) | Out-Null`, { DSH_BOOT_PATH: dir })
  } else fs.mkdirSync(dir, { mode: 0o700 })
  assertOwner(dir, true)
  return dir
}
function atomicPrivateWrite(dir, name, data) {
  const target = path.join(dir, name)
  const temp = path.join(dir, '.' + randomUUID() + '.tmp')
  let fd
  try {
    fd = fs.openSync(temp, 'wx', 0o600)
    assertOwner(temp)
    fs.writeFileSync(fd, data, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd); fd = undefined
    if (fs.existsSync(target)) {
      if (process.platform === 'win32') hardenWindowsAcl(target)
      else assertOwner(target)
    }
    fs.renameSync(temp, target)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}
function validate(record, port) {
  if (record.version !== 1 || record.port !== port || typeof record.instanceId !== 'string' || !/^[0-9a-f-]{36}$/.test(record.instanceId)) throw new Error('BOOTSTRAP_INVALID_RECORD')
  const u = new URL(record.authenticatedRootUrl)
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || +u.port !== port || u.pathname !== '/' || u.username || u.password || u.hash || [...u.searchParams.keys()].join(',') !== 'token' || !u.searchParams.get('token')) throw new Error('BOOTSTRAP_INVALID_URL')
  if (!record.processStamp || processStamp(record.pid) !== record.processStamp) throw new Error('BOOTSTRAP_STALE_INSTANCE')
  return record
}
function readBootstrap(port, home = os.homedir()) {
  port = portNumber(port)
  const dir = path.join(home, '.dsh-mobile')
  if (process.platform === 'win32') hardenWindowsAcl(dir, true)
  else assertOwner(dir, true)
  const file = path.join(dir, `bootstrap-${port}.json`)
  if (process.platform === 'win32') hardenWindowsAcl(file)
  else assertOwner(file)
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.size > LIMIT) throw new Error('BOOTSTRAP_INVALID_SIZE')
    const record = validate(JSON.parse(fs.readFileSync(fd, 'utf8')), port)
    return { version: 1, port, pid: record.pid, instanceId: record.instanceId, authenticatedRootUrl: record.authenticatedRootUrl }
  } finally { fs.closeSync(fd) }
}
function publishBootstrap(port, authenticatedRootUrl, home = os.homedir()) {
  port = portNumber(port)
  const record = { version: 1, port, pid: process.pid, instanceId: randomUUID(), processStamp: processStamp(process.pid), issuedAt: new Date().toISOString(), authenticatedRootUrl }
  validate(record, port)
  const data = JSON.stringify(record)
  if (Buffer.byteLength(data) > LIMIT) throw new Error('BOOTSTRAP_INVALID_SIZE')
  const dir = ensureDirectory(home)
  atomicPrivateWrite(dir, 'read-bootstrap.cjs', fs.readFileSync(__filename, 'utf8'))
  atomicPrivateWrite(dir, `bootstrap-${port}.json`, data)
  return () => {
    const file = path.join(dir, `bootstrap-${port}.json`)
    try {
      assertOwner(file)
      if (JSON.parse(fs.readFileSync(file, 'utf8')).instanceId === record.instanceId) fs.unlinkSync(file)
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('BOOTSTRAP_CLEANUP_FAILED') }
  }
}
module.exports = { publishBootstrap, readBootstrap, portNumber }
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(readBootstrap(process.argv[2]))) }
  catch { process.stderr.write('DSH_BOOTSTRAP_UNAVAILABLE\n'); process.exitCode = 1 }
}
