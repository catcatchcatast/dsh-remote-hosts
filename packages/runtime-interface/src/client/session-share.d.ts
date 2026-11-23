// Public change history: docs/PUBLIC-CHANGES.md
export interface SessionShareOwnerRoute {
  readonly kind: 'local' | 'remote'
  readonly scopeKey: string
  readonly rawSessionId: string
  mapSessionId(raw: string): string
  request<T>(path: string, init?: RequestInit): Promise<T>
}

export interface SessionShareClient {
  resolveOwnerRoute(sessionId: string): SessionShareOwnerRoute
  install(options: {
    headerAction: (props: { sessionId: string }) => unknown
    selectReadOnlyComposer: (props: { sessionId: string }) => boolean
    readOnlyComposer: (props: { sessionId: string }) => unknown
  }): { refreshComposer(): void; dispose(): void }
}

export function createSessionShareClient(slots: unknown, options: { createElement: (type: unknown, props: unknown) => unknown }): SessionShareClient

declare module '@deepseek-ai/cordis' {
  interface Context { sessionShareClient: SessionShareClient }
}
