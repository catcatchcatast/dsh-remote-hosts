// Public change history: docs/PUBLIC-CHANGES.md
export interface SessionShareSourceSnapshot {
  readonly sessionId: string
  readonly workspaceRoot: string
  readonly sourceAnchorSeq: number
  readonly title?: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly modelAcceptsImages: boolean
  readonly imageLimits: Readonly<Record<string, number>>
}

export interface SessionSharePolicy {
  readonly state: 'ACTIVE'
  readonly branchSessionId: string
  readonly workspaceRoot: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly isAuthorizedVisitorMessage: (messageId: string) => boolean
  readonly normalizeImage: (input: { declaredMediaType: string; bytes: Uint8Array }) => Promise<{ bytes: Uint8Array; mediaType: string } | undefined>
}

export interface SessionShareOwnerRequest {
  readonly method: string
  readonly path: string
  readonly remoteAddress?: string
  readonly host?: string
  readonly body?: Record<string, unknown>
}

export interface SessionShareOwnerResponse {
  readonly status: number
  readonly body: unknown
}

export interface SessionSharePublicRequest {
  readonly method: string
  readonly url: string
  readonly remoteAddress?: string
  readonly headers: Readonly<{
    host?: string
    origin?: string
    cookie?: string
    csrf?: string
    contentType?: string
  }>
  readonly body: Uint8Array
}

export interface SessionSharePublicEvent {
  readonly event: 'ledger' | 'revoked'
  readonly id?: string | number
  readonly data?: unknown
}

export interface SessionSharePublicResponse {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Uint8Array
  readonly events?: AsyncIterable<SessionSharePublicEvent>
}

export interface SessionSharePublicListenerOptions {
  readonly host: string
  readonly port: number
  readonly tls: { readonly cert: Uint8Array; readonly key: Uint8Array; readonly minVersion?: string }
  readonly handler: (request: SessionSharePublicRequest, signal: AbortSignal) => SessionSharePublicResponse | Promise<SessionSharePublicResponse>
}

export interface SessionShareDeliveryReceipt {
  readonly messageId: string
  readonly position: number
  readonly running: boolean
}

export interface SessionShareQuestionOption {
  readonly label: string
  readonly description?: string
}

export interface SessionShareQuestion {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly SessionShareQuestionOption[]
  readonly multiSelect?: true
}

export type SessionShareQuestionEvent =
  | { readonly type: 'question-requested'; readonly sessionId: string; readonly rpcId: string; readonly questions: readonly SessionShareQuestion[] }
  | { readonly type: 'question-resolved'; readonly rpcId: string; readonly outcome: string }

export interface SessionShareInterfaceError extends Error {
  readonly code: 'SHARE_AGENT_RESOLUTION_FAILED'
  readonly source: 'session-controller'
  readonly reason: string
  readonly status: number
}

export interface SessionShareInterface {
  readonly presetId: string
  createInstallation(): SessionShareInterface
  ready(): Promise<boolean>
  activate(binding: {
    resolvePolicy(branchSessionId: string): SessionSharePolicy | undefined | Promise<SessionSharePolicy | undefined>
    onSessionEvent(event: Readonly<Record<string, unknown>>): void
    onQuestionEvent(event: SessionShareQuestionEvent): void
    onQuestionError(code: string): void
  }): Promise<() => Promise<void>>
  registerOwnerRoute(handler: (request: SessionShareOwnerRequest) => Promise<SessionShareOwnerResponse>): () => void
  listenPublicHttps(options: SessionSharePublicListenerOptions): Promise<() => Promise<void>>
  inspectSource(sessionId: string): Promise<SessionShareSourceSnapshot>
  isProtectedShareBranch(sessionId: string): Promise<boolean>
  createRestrictedBranch(input: {
    sourceSessionId: string
    branchSessionId: string
    sourceAnchorSeq: number
    title: string
    policy: SessionSharePolicy
  }): Promise<{ readonly branchSessionId: string }>
  discardRestrictedBranch(branchSessionId: string): Promise<void>
  ensureRestrictedBranch(input: { branchSessionId: string; removeMessageIds?: readonly string[] }): Promise<{ readonly status: string; readonly pending: number }>
  enqueueVisitorMessage(input: {
    branchSessionId: string
    text: string
    images?: readonly { bytes: Uint8Array; mediaType: string }[]
    beforeDelivery(receipt: SessionShareDeliveryReceipt): Promise<void>
    onDeliveryFailure?(receipt: SessionShareDeliveryReceipt): Promise<void>
  }): Promise<SessionShareDeliveryReceipt>
  cancelAndRemoveGuestMessages(branchSessionId: string, messageIds: readonly string[], options?: { readonly liveOnly?: boolean }): Promise<{ readonly live: boolean; readonly removedCount: number }>
  respondQuestion(branchSessionId: string, rpcId: string, answer: unknown): Promise<{ readonly accepted: boolean }>
  dispose(): Promise<void>
}

export function createSessionShareInterface(ctx: unknown): SessionShareInterface
export function installSessionShareAgentPreset(ctx: unknown): Promise<void>

declare module '@deepseek-ai/cordis' {
  interface Context { sessionShareInterface: SessionShareInterface }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-session-share-visitor': { kind: 'dsh-session-share-visitor' }
  }
}
