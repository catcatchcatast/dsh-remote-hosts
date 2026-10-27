class FixtureResizeObserver { observe(){} unobserve(){} disconnect(){} }
globalThis.ResizeObserver=FixtureResizeObserver as any
import {createElement} from 'react'
// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                          
// @vitest-environment jsdom
// InputBar behavior over the editor + submit-machine wiring: Enter-send
// semantics (IME guard, Shift newline, busy Enter policy, Ctrl/Meta steering,
// repeat suppression), running semantics (input stays free; continuable
// children keep Send beside Stop), the machine pending lock, chip decorators,
// error banners, status strips, and the focus-keeping mousedown. Keyboard
// gestures dispatch real KeyboardEvents at the contenteditable (the Lexical
// root listener routes them through the keymap commands); draft writes drive
// the shell (jsdom's beforeinput lacks the ranges Lexical needs).

import '@public-official/packages/client/ui-conversation/tests/control-row-dom.ts'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { $getRoot, $isTextNode } from 'lexical'
import {
  allowAllAccess, bindSnapshotSelector, conversationSnapshot as conversationFixture, makeTranslate, RemoteError,
  sessionSnapshot as sessionFixture,
} from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionListState, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ContextPressureProjection } from '@deepseek-ai/dsh-token-meter/client'
import { zh as commonZh } from '@public-official/packages/client/locale/src/locales/zh.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubmitOutcome } from '@public-official/packages/client/ui-conversation/src/client/contract/input.ts'
import { SessionInputShell } from '@public-official/packages/client/ui-conversation/src/client/input/facade.ts'
import { $replaceDetectSpanWithText, $selectDetectSpan } from '@public-official/packages/client/ui-conversation/src/client/input/editor/span-map.ts'
import type {
  ComposerAttachment, ComposerAttachmentsOwnerProps, DraftFileUploads, InputActivityOwnerProps,
} from '@public-official/packages/client/ui-conversation/src/client/contract/slots.ts'
import type { DraftAttachmentId } from '@public-official/packages/client/ui-conversation/src/client/contract/input.ts'
import { InputBar } from '@public-official/packages/client/ui-conversation/src/client/skeleton/InputBar.tsx'
import type { InputBarProps } from '@public-official/packages/client/ui-conversation/src/client/skeleton/InputBar.tsx'
import { en, zh } from '@public-official/packages/client/ui-conversation/src/client/locales.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined })) as GlobalStandardProps['useResource']

afterEach(cleanup)

// jsdom implements no Range geometry at all — `Range.prototype.getBoundingClientRect`
// is absent — and the composer measures the caret with one when it restores the
// selection after an edit it performed itself. Every case here runs against a
// zero rect; the reveal case below substitutes its own and restores this one.
const ZERO_RECT = (): DOMRect => ({ top: 0, bottom: 0 }) as DOMRect
Range.prototype.getBoundingClientRect = ZERO_RECT

const SCTX = {} as Context
const SID = 's1' as SessionId
const CONTINUABLE_CHILD = {
  address: { parentSessionId: 'parent' as SessionId, childSessionId: SID, mode: 'continuable' as const },
  parentAvailable: true,
}

function snapshotOf(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { ...sessionFixture(SID), ...overrides }
}

interface BenchOptions {
  sessionId?: any
  Recall?: any
  chatNodes?: readonly any[]
  planEntry?: React.ReactNode
  /** The `plan` projection value the standard-kit useProjection serves. */
  plan?: { active: boolean; pending: boolean }
  /** The `goal` projection value used only to prove attachment intake remains ordinary. */
  goal?: { phase: 'active'; objective: string }
  modelEntry?: React.ReactNode
  permissionEntry?: React.ReactNode
  /** Hot text-ref lexicon (injects a minimal slash stub exposing only lexicon()). */
  lexicon?: ReadonlyMap<'/' | '@', readonly string[]>
  /** The `imageLimits` projection value (absent = no attachment service). */
  imageLimits?: {
    maxImageBytes: number
    maxImagesPerMessage: number
    maxMessageImageBytes: number
    maxImagePixels: number
    maxImageDimension: number
    mediaTypes: readonly ('image/png' | 'image/jpeg' | 'image/webp' | 'image/gif')[]
  }
  draft?: string
  running?: boolean
  subagent?: Exclude<SessionSnapshot['subagent'], null>
  disabled?: boolean
  inert?: boolean
  blocked?: { readonly reason: string }
  workspacePickerOpen?: boolean
  onRequestWorkspace?: () => void
  promptError?: SessionSnapshot['promptError']
  /** Authoritative queue rows served to the machine overlay (empty = none). */
  queue?: InboxState['next-turn']
  nextStep?: InboxState['next-step']
  /** The hub's steer-all face (empty-draft accelerated Enter). */
  steerQueue?: () => void
  variant?: 'hero' | 'composer'
  placeholder?: string
  t?: InputBarProps['t']
  accessory?: React.ReactNode
  overlay?: React.ReactNode
  leftItems?: React.ReactNode
  rightItems?: React.ReactNode
  activityEntry?: (owner: InputActivityOwnerProps) => React.ReactNode
  contextPressure?: ContextPressureProjection
  footer?: React.ReactNode
  attachments?: readonly ComposerAttachment[]
  /** Upload states served for file-kind drafts (absent = every file is ready). */
  fileUploads?: DraftFileUploads
  addFiles?: (files: readonly File[], directories?: ReadonlySet<File>) => string | null
  commandMenuOpen?: boolean
  busyEnter?: 'queue' | 'steer'
  toggleCommandMenu?: (selection: { start: number; end: number }) => void
}

/** One pending queue row (the runtime snapshot shape, as the dock tests build it). */
function row(id: string): InboxState['next-turn'][number] {
  return {
    id: id as never, role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: id }],
  }
}

/** Real machine behind the bar entry: sink spy, no slash pipeline (plain text goes straight to the sink). */
export function bench(over?: BenchOptions) {
  const sid=over?.sessionId??SID
  const sink = vi.fn<(
    text: string,
    attachmentIds: readonly DraftAttachmentId[],
    mode: 'queue' | 'steer',
    signal: AbortSignal,
  ) => Promise<SubmitOutcome>>(() => Promise.resolve({ kind: 'success' }))
  const lex = over?.lexicon
  const session = createSnapshotStore<SessionSnapshot>(snapshotOf({ id:sid,
    running: over?.running ?? false,
    subagent: over?.subagent ?? null,
    removed: over?.disabled ?? false,
    promptError: over?.promptError ?? null,
  }))
  type ShellDeps = ConstructorParameters<typeof SessionInputShell>[0]
  const shell = new SessionInputShell({
    actx: SCTX,
    defaultSink: sink,
    commandAttachments: { serialize: () => Promise.resolve([]), release: () => {}, unsupportedNotice: (token: string) => `${token.trim()} attachments-unsupported` },
    inbox: createSnapshotStore<InboxState>({
      'next-turn': over?.queue ?? [],
      'next-step': over?.nextStep ?? [],
    }),
    ...(over?.steerQueue !== undefined ? { steerQueue: over.steerQueue } : {}),
    // Lexicon-only stub: adjudication untouched (undefined slash methods are
    // never reached — these benches drive plain-draft flows only).
    ...(lex !== undefined
      ? {
        inputTriggers: (() => ({
          track: () => {},
          lexicon: { getSnapshot: () => lex, subscribe: () => () => {} },
        })) as unknown as NonNullable<ShellDeps['inputTriggers']>,
      }
      : {}),
  })
  if (over?.draft !== undefined && over.draft !== '') shell.setDraft(over.draft)
  if (over?.attachments !== undefined) shell.addAttachments(over.attachments.map(attachment => attachment.id))
  const stop = vi.fn()
  const removeAttachment = vi.fn((id: DraftAttachmentId) => { shell.removeAttachment(id) })
  const menuLauncher = createSnapshotStore<string | null>(over?.commandMenuOpen === true ? 'command' : null)
  const busyEnter = createSnapshotStore<'queue' | 'steer'>(over?.busyEnter ?? 'queue')
  const stopShortcut = createSnapshotStore<readonly string[]>(['Esc', 'Esc'])
  const slotCalls: { key: string; owner: unknown }[] = []
  const renderSlot = ((key: string, owner: object) => {
    slotCalls.push({ key, owner })
    if (key === 'conversation.input.overlay') return over?.overlay ?? (over?.Recall ? createElement(over.Recall, {sessionId:sid,useSession:bindSnapshotSelector(session),useInput:bindSnapshotSelector(shell.state),inputActions:shell.actions,useConversation:bindSnapshotSelector(conversation)}) : null)
    if (key === 'conversation.input.left') return over?.leftItems ?? null
    if (key === 'conversation.input.right') return over?.rightItems ?? null
    if (key === 'conversation.composer.dock') return over?.footer ?? null
    if (key === 'conversation.input.plan') return over?.planEntry ?? null
    if (key === 'conversation.input.permission') return over?.permissionEntry ?? null
    if (key === 'conversation.input.model') return over?.modelEntry ?? null
    if (key === 'conversation.input.activity') return over?.activityEntry?.(owner as InputActivityOwnerProps) ?? null
    return null
  }) as never
  const conversation=createSnapshotStore({views:{get:(target:string)=>target==='chat'?{nodes:{values:()=>over?.chatNodes??[]}}:undefined},activeTargets:new Set(['chat'])})
  const props: InputBarProps = {
    usePanelInfo: selector => selector({ activePanelId: null }),
    sessionId: sid,
    SessionProvider: ({ children }) => children,
    useSession: bindSnapshotSelector(session),
    useConversation: bindSnapshotSelector(createSnapshotStore(conversationFixture())),
    useSessionStatus: bindSnapshotSelector(createSnapshotStore(new Map())),
    useSessionRetainInfo: () => undefined,
    useResource,
    useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>({
      ids: [], byId: {}, phase: 'ready',
      projectionsBySession: {},
    })),
    useWorkspaces: bindSnapshotSelector(createSnapshotStore({
      items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    })),
    ...allowAllAccess,
    useProjection: ((key: string, selector?: (v: unknown) => unknown) =>
      (selector ?? (v => v))(key === 'plan'
        ? over?.plan
        : key === 'goal' ? over?.goal
          : key === 'imageLimits' ? over?.imageLimits
            : key === 'contextPressure' ? over?.contextPressure : undefined)),
    useInput: bindSnapshotSelector(shell.state),
    inputActions: shell.actions,
    keyboard: shell,
    addFiles: over?.addFiles ?? (() => null),
    useFileUploads: bindSnapshotSelector(createSnapshotStore<DraftFileUploads>(over?.fileUploads ?? {})),
    retryFileUpload: undefined,
    removeAttachment,
    resolveDraftAttachments: ids => ids.flatMap((id) => {
      const attachment = over?.attachments?.find(candidate => candidate.id === id)
      return attachment === undefined ? [] : [attachment]
    }),
    toggleCommandMenu: over?.toggleCommandMenu ?? vi.fn(),
    useBusyEnter: bindSnapshotSelector(busyEnter),
    useStopShortcut: bindSnapshotSelector(stopShortcut),
    useNotices: bindSnapshotSelector(shell.notices),
    useLexicon: bindSnapshotSelector(shell.lexicon),
    useMenuLauncher: bindSnapshotSelector(menuLauncher),
    stop,
    // Mirrors the real lookup chain (conversation namespace, then common).
    t: over?.t ?? makeTranslate(zh, commonZh),
    renderSlot,
    variant: over?.variant ?? 'composer',
    ...(over?.inert === true ? { disabled: true } : {}),
    ...(over?.blocked !== undefined ? { blocked: over.blocked } : {}),
    ...(over?.workspacePickerOpen !== undefined ? { workspacePickerOpen: over.workspacePickerOpen } : {}),
    ...(over?.onRequestWorkspace !== undefined ? { onRequestWorkspace: over.onRequestWorkspace } : {}),
    ...(over?.placeholder !== undefined ? { placeholder: over.placeholder } : {}),
    ...(over?.accessory !== undefined ? { accessory: over.accessory } : {}),
  }
  const view = render(<InputBar {...props} />)
  const textarea = view.container.querySelector<HTMLDivElement>('[data-composer-input]')!
  const sendableDraft = (over?.draft?.trim() ?? '') !== '' || (over?.attachments?.length ?? 0) > 0
  const primaryStops = over?.running === true && over.subagent === undefined
    && (!sendableDraft || over.blocked !== undefined)
  // A running steer-capable composer (ordinary session or continuable child
  // with its parent online) labels Send by the delivery mode it performs over
  // a plain message draft; idle sessions, one-shot children, locked
  // composers, a child's empty draft, drafts with a pending upload, and `/`
  // command lines keep plain Send (an ordinary running session's empty draft
  // is the Stop seat). The mirror models plain-phase drafts only: cases
  // that claim a command or freeze the machine query the DOM directly.
  const steeringAvailable = over?.subagent === undefined || over.subagent.address.mode === 'continuable'
  const composerLocked = over?.disabled === true || over?.inert === true || over?.blocked !== undefined
    || (over?.subagent?.address.mode === 'continuable' && over.subagent.parentAvailable !== true)
  const uploadsPending = (over?.attachments ?? []).some(attachment =>
    attachment.kind === 'file' && over?.fileUploads?.[attachment.id]?.status !== 'ready')
  const plainMessageDraft = sendableDraft && !uploadsPending && !(over?.draft?.trimStart().startsWith('/') ?? false)
  const primaryLabel = primaryStops
    ? '停止生成'
    : over?.running === true && steeringAvailable && !composerLocked && plainMessageDraft
      ? (over.busyEnter === 'steer' ? '插话发送' : '排队发送')
      : '发送消息'
  const button = view.container.querySelector<HTMLButtonElement>(`button[aria-label="${primaryLabel}"]`)!
  const interruptButton = view.container.querySelector<HTMLButtonElement>('button[aria-label="停止生成"]')
  return {
    view, textarea, button, interruptButton, props, sink, shell, wiring: shell, session, stop, removeAttachment, slotCalls,
    menuLauncher, busyEnter, stopShortcut,
    steerQueue: over?.steerQueue,
    get placeholder() { return placeholderOf(view.container) },
    get inputDisabled() { return textarea.getAttribute('aria-disabled') === 'true' },
  }
}

// 原官方bench getter所需的辅助函数，原样补齐有界提取。
function placeholderOf(container: HTMLElement): string {
  return container.querySelector('[data-composer-input]')?.getAttribute('data-placeholder') ?? ''
}
