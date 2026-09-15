const CONNECTION_PREFIX = 'HOST_CONNECTION_FAILED_'
const PUBLIC_CODES = new Set([
  'HOST_ID_INVALID',
  'HOST_ALIAS_INVALID',
  'HOST_PORT_INVALID',
  'HOST_LAUNCH_INVALID',
  'DUPLICATE_HOST_TARGET',
  'HOST_NOT_FOUND',
  'HOST_LOCAL_READONLY',
  'HOST_RESTART_PARAMS_INVALID',
  'LOCAL_RESTART_UNAVAILABLE',
  'LOCAL_RESTART_DESCRIPTOR_INVALID',
  'LOCAL_RESTART_DESCRIPTOR_FIELDS',
  'LOCAL_RESTART_DESCRIPTOR_IDENTITY',
  'LOCAL_RESTART_BROKER_FAILED',
  'LOCAL_RESTART_READY_TIMEOUT',
  'LOCAL_RESTART_APP_EXIT_FAILED',
  'LOCAL_RESTART_FAILED',
  'LOCAL_RESTART_PORT_UNKNOWN',
  'LOCAL_RESTART_PORT_OCCUPIED',
  'LOCAL_RESTART_LAUNCH_FAILED',
  'LOCAL_RESTART_EXIT_TIMEOUT',
  'LOCAL_RESTART_EXIT_FAILED',
  'MANAGED_RUNTIME_BUSY',
  'RESTART_UNSUPPORTED',
  'RESTART_FAILED',
  'SSH_HELPER_UNAVAILABLE',
  'SSH_ALIAS_UNAVAILABLE',
  'FORWARD',
  'BOOTSTRAP_READ',
  'BOOTSTRAP_VALIDATE',
  'AUTHENTICATION',
  `${CONNECTION_PREFIX}FORWARD`,
  `${CONNECTION_PREFIX}BOOTSTRAP_READ`,
  `${CONNECTION_PREFIX}BOOTSTRAP_VALIDATE`,
  `${CONNECTION_PREFIX}AUTHENTICATION`,
])

export function publicErrorCode(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (PUBLIC_CODES.has(message)) return message
  if (message.startsWith(CONNECTION_PREFIX)) {
    const stage = message.slice(CONNECTION_PREFIX.length)
    if (stage === 'FORWARD' || stage === 'BOOTSTRAP_READ' || stage === 'BOOTSTRAP_VALIDATE' || stage === 'AUTHENTICATION') {
      return message
    }
  }
  return 'HOST_UNAVAILABLE'
}

export function publicHost(record) {
  if (record.kind === 'local') {
    return {
      id: 'local',
      kind: 'local',
      label: record.label ?? 'Local',
      state: record.state ?? 'offline',
      lastError: record.lastError ?? null,
      localPort: record.localPort,
      helperReadable: record.helperReadable === true,
      restartAvailable: record.restartAvailable === true,
      ...(typeof record.restartState === 'string' ? { restartState: record.restartState } : {}),
      enabled: true,
    }
  }
  return {
    id: record.id,
    kind: 'remote',
    label: record.label,
    alias: record.alias,
    state: record.enabled === false ? 'disabled' : (record.state ?? 'offline'),
    lastError: record.lastError ?? null,
    localPort: record.localPort,
    remotePort: record.remotePort,
    launch: record.launch === 'systemd-user' ? 'systemd-user' : 'none',
    enabled: record.enabled !== false,
    restartAvailable: record.launch === 'systemd-user',
    helperReadable: record.helperReadable === true,
  }
}
