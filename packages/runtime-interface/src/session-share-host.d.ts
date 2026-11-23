// Public change history: docs/PUBLIC-CHANGES.md
export interface SessionShareHostConfiguration {
  role: 'host' | 'control'
  isolatedLoopback: boolean
  publicHost: string
  publicPort: number
  allowedCidrs: string[]
  dataDir: string
  tlsCertificate: string
  tlsPrivateKey: string
}
export const SessionShareHostConfig: { parse(value: unknown): SessionShareHostConfiguration }
export function assertSessionShareNetwork(value: Pick<SessionShareHostConfiguration, 'publicHost' | 'publicPort' | 'allowedCidrs'> & { isolatedLoopback?: boolean }): void
export function resolveSessionShareHostConfig(value: unknown, environment?: Record<string, string | undefined>): Promise<SessionShareHostConfiguration>
export function bindSessionShareHost(ctx: unknown, value: unknown): Promise<{
  config: SessionShareHostConfiguration
  sessionShare: import('./session-share-interface.js').SessionShareInterface
  registerCleanup(cleanup: () => Promise<void>): void
  reportNetworkStatus(status: 'active' | 'inactive' | 'unavailable'): void
  dispose(): Promise<void>
}>
