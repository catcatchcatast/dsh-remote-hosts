// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                     
                                                                                                                                         
                                                                                                                                                 
'use strict'
                                                                                                                                 
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID, createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')

const LIMIT = 4096
function portNumber(value) {
  if (!/^\d{1,5}$/.test(String(value)) || +value < 1 || +value > 65535) throw new Error('BOOTSTRAP_INVALID_PORT')
  return +value
}
function ps(script, env = {}, input) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 8192,
    env: { ...process.env, ...env }, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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
function atomicPrivateWrite(dir, name, data, immutable = false) {
  const target = path.join(dir, name)
  const temp = path.join(dir, '.' + randomUUID() + '.tmp')
  let fd, owned = false
  try {
    if (process.platform === 'win32') {
      // 创建时绑定当前SID，而非采用管理员token的默认BA所有者；正文只经stdin进入同一句柄。
      const input = Buffer.from(data, 'utf8')
      const result = ps(`$ErrorActionPreference='Stop'; $p=$env:DSH_BOOT_PATH; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object Security.AccessControl.FileSecurity; $a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false); foreach($id in @($sid.Value,'S-1-5-18')){$r=New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]$id,'FullControl','None','None','Allow'); $a.AddAccessRule($r)}; $owned=$false; $complete=$false; try{$stream=[IO.FileStream]::new($p,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::None,$a); $owned=$true; try{$inputStream=[Console]::OpenStandardInput(); $inputStream.CopyTo($stream); if($stream.Length -ne [long]$env:DSH_BOOT_LENGTH){throw 'length'}; $stream.Flush($true)}finally{$stream.Dispose()}; $complete=$true}finally{if($owned -and -not $complete){[IO.File]::Delete($p)}}; 'ok'`, { DSH_BOOT_PATH: temp, DSH_BOOT_LENGTH: String(input.length) }, input)
      if (result !== 'ok') throw new Error('BOOTSTRAP_UNSAFE_PERMISSIONS')
      owned = true
      assertOwner(temp)
    } else {
      fd = fs.openSync(temp, 'wx', 0o600)
      owned = true
      assertOwner(temp)
      fs.writeFileSync(fd, data, 'utf8')
      fs.fsyncSync(fd)
      fs.closeSync(fd); fd = undefined
    }
    if (immutable) {
      try { fs.linkSync(temp, target) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
      if (!readPrivateAdapter(target).equals(Buffer.from(data, 'utf8'))) throw new Error('BOOTSTRAP_INVALID_ADAPTER')
      return
    }
    if (fs.existsSync(target)) {
      if (process.platform === 'win32') hardenWindowsAcl(target)
      else assertOwner(target)
    }
    fs.renameSync(temp, target)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (owned && fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}
function readPrivateAdapter(target) {
  assertOwner(target)
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.size > 65536) throw new Error('BOOTSTRAP_INVALID_ADAPTER')
    const buffer = Buffer.alloc(65537)
    let size = 0, read
    while (size < buffer.length && (read = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += read
    if (size > 65536) throw new Error('BOOTSTRAP_INVALID_ADAPTER')
    return buffer.subarray(0, size)
  } finally { fs.closeSync(fd) }
}
function validateIdentity(record, port) {
  if (record.version !== 1 || record.port !== port || typeof record.instanceId !== 'string' || !/^[0-9a-f-]{36}$/.test(record.instanceId)) throw new Error('BOOTSTRAP_INVALID_RECORD')
  let stamp
  try { stamp = processStamp(record.pid) } catch { throw new Error('BOOTSTRAP_STALE_INSTANCE') }
  if (!record.processStamp || stamp !== record.processStamp) throw new Error('BOOTSTRAP_STALE_INSTANCE')
  return record
}
function validate(record, port) {
  validateIdentity(record, port)
  const u = new URL(record.authenticatedRootUrl)
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || +u.port !== port || u.pathname !== '/' || u.username || u.password || u.hash || [...u.searchParams.keys()].join(',') !== 'token' || !u.searchParams.get('token')) throw new Error('BOOTSTRAP_INVALID_URL')
  return record
}
function readRecord(port, home = os.homedir(), legacy = true) {
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
    const record = JSON.parse(fs.readFileSync(fd, 'utf8'))
    ;(legacy ? validate : validateIdentity)(record, port)
    return record
  } finally { fs.closeSync(fd) }
}
function readBootstrap(port, home = os.homedir()) {
  const record = readRecord(port, home)
  return { version: 1, port: record.port, pid: record.pid, instanceId: record.instanceId, authenticatedRootUrl: record.authenticatedRootUrl }
}
async function readBootstrapV2(request, { signal, home = os.homedir() } = {}) {
  // Only stable interface operations are invoked here; official decoding stays in the published adapter.
  const retryable = new Set(['UNAVAILABLE', 'STALE_INSTANCE', 'TIMEOUT'])
  const codes = new Set(['INVALID_REQUEST', 'UNAVAILABLE', 'UNSAFE_MATERIAL', 'STALE_INSTANCE', 'AUTHENTICATION_FAILED', 'TIMEOUT', 'CANCELLED', 'OUTPUT_TOO_LARGE'])
  const failure = code => ({ version: 2, ok: false, error: { code, retryable: retryable.has(code) } })
  try {
    if (signal?.aborted) return failure('CANCELLED')
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).sort().join(',') !== 'forwardPort,generation,port,version' ||
        request.version !== 2 || !Number.isSafeInteger(request.port) || request.port < 1 || request.port > 65535 ||
        !Number.isSafeInteger(request.forwardPort) || request.forwardPort < 1024 || request.forwardPort > 65535 ||
        typeof request.generation !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.generation)) return failure('INVALID_REQUEST')
    const material = readRecord(request.port, home, false)
    if (material.authAdapterSha256 === undefined) return failure('UNAVAILABLE')
    if (typeof material.authAdapterSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(material.authAdapterSha256)) return failure('UNSAFE_MATERIAL')
    const adapterPath = path.join(home, '.dsh-mobile', `read-bootstrap-auth-${material.authAdapterSha256}.cjs`)
    const source = readPrivateAdapter(adapterPath)
    if (createHash('sha256').update(source).digest('hex') !== material.authAdapterSha256) return failure('UNSAFE_MATERIAL')
    const adapter = require(adapterPath)
    const binding = adapter.validateRequest(request)
    const headers = await adapter.exchangeCredential(material, binding, { signal })
    if (signal?.aborted) return failure('CANCELLED')
    const after = readRecord(binding.port, home, false)
    if (after.pid !== material.pid || after.instanceId !== material.instanceId || after.processStamp !== material.processStamp ||
        after.authenticatedRootUrl !== material.authenticatedRootUrl || after.authAdapterSha256 !== material.authAdapterSha256) return failure('STALE_INSTANCE')
    return adapter.success(material, binding, headers)
  } catch (error) {
    const code = codes.has(error?.code) ? error.code : error?.code === 'ENOENT' ? 'UNAVAILABLE' :
      /BOOTSTRAP_STALE_INSTANCE/.test(error?.message ?? '') ? 'STALE_INSTANCE' : 'UNSAFE_MATERIAL'
    return failure(code)
  }
}
function publishBootstrap(port, authenticatedRootUrl, home = os.homedir(), authAdapterSource) {
  port = portNumber(port)
  const record = { version: 1, port, pid: process.pid, instanceId: randomUUID(), processStamp: processStamp(process.pid), issuedAt: new Date().toISOString(), authenticatedRootUrl }
  if (authAdapterSource !== undefined) {
    if (typeof authAdapterSource !== 'string' || Buffer.byteLength(authAdapterSource) > 65536) throw new Error('BOOTSTRAP_INVALID_ADAPTER')
    record.authAdapterSha256 = createHash('sha256').update(authAdapterSource).digest('hex')
  }
  ;(authAdapterSource === undefined ? validate : validateIdentity)(record, port)
  const data = JSON.stringify(record)
  if (Buffer.byteLength(data) > LIMIT) throw new Error('BOOTSTRAP_INVALID_SIZE')
  const dir = ensureDirectory(home)
  if (authAdapterSource !== undefined) atomicPrivateWrite(dir, `read-bootstrap-auth-${record.authAdapterSha256}.cjs`, authAdapterSource, true)
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
module.exports = { publishBootstrap, readBootstrap, readBootstrapV2, portNumber }
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(readBootstrap(process.argv[2]))) }
  catch { process.stderr.write('DSH_BOOTSTRAP_UNAVAILABLE\n'); process.exitCode = 1 }
}
