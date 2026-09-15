/** Concrete OpenSSH alias helpers. Hostnames never leave this module. */

export function isConcreteSshAlias(alias) {
  return typeof alias === 'string' && alias !== '' && !alias.startsWith('-') && !/[*?!]/.test(alias)
    && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(alias)
}

export function parseConcreteSshAliases(text) {
  if (typeof text !== 'string') return []
  const aliases = []
  const seen = new Set()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim()
    const match = /^host\s+(.+)$/i.exec(line)
    if (match === null) continue
    for (const alias of match[1].trim().split(/\s+/)) {
      if (!isConcreteSshAlias(alias) || seen.has(alias)) continue
      seen.add(alias)
      aliases.push(alias)
    }
  }
  return aliases
}

/** Map an SSH alias to a Host id. Dots are not allowed in ids. */
export function hostIdFromAlias(alias) {
  if (!isConcreteSshAlias(alias)) throw new Error('HOST_ALIAS_INVALID')
  const id = alias.toLowerCase().replaceAll('.', '-')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || id === 'local') throw new Error('HOST_ID_INVALID')
  return id
}

export function suggestLocalPort(used, start = 33080) {
  const taken = new Set(used)
  let port = start
  while (taken.has(port) || port < 1024 || port > 65535) {
    port += 1
    if (port > 65535) throw new Error('HOST_PORT_INVALID')
  }
  return port
}
