
/**
 * The browse picking occupant (package-internal; the `./client` surface
 * exposes only the Loader exports). Same-package tests exercise it directly
 * through this module.
 */
import { createElement, useCallback, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type { Translate } from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the owner contract of the directory-flow holes.
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { DirectoryBrowser } from './DirectoryBrowser.tsx'
import { HostPicker, selectedHostId } from './HostPicker.tsx'

/** Injected face: the browse wire calls and copy the dialog drives (bound in apply's closure). */
export interface BrowseFlowInjected {
  /** List one directory level (absent path = the Host home directory); the signal aborts a superseded scan. */
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  /** Create one child directory under an existing parent. */
  createDirectory: (path: string, name: string) => Promise<string>
  /** Localized dialog copy (this package's namespace). */
  t: Translate
}

/**
 * Flow occupant: adapts the hole's owner conversation onto the browser
 * dialog — a confirmed directory is the picked path, dismissal is the
 * cancellation. Browse failures (unreadable targets, create conflicts) stay
 * inside the dialog's own alert surfaces, so the owner's `onError` arm is
 * never driven by this occupant.
 * @param props - owner conversation plus the injected browse face.
 * @returns the dialog element (renders nothing while closed).
 */
export function BrowseDirectoryFlow(props: DirectoryFlowOwnerProps & BrowseFlowInjected): ReactElement {
  // The selected Host is part of this picker instance, not a global visible
  // control. The hub keeps the page-local selection and applies it to the
  // following official directory/workspace RPCs.
  const [selectedHost, setSelectedHost] = useState(selectedHostId)
  const listDirectoryRef = useRef((path?: string, signal?: AbortSignal) =>
    props.listDirectory(path, signal))
  const createDirectoryRef = useRef((path: string, name: string) =>
    props.createDirectory(path, name))
  listDirectoryRef.current = (path, signal) => props.listDirectory(path, signal)
  createDirectoryRef.current = (path, name) => props.createDirectory(path, name)
  // Multi-Host status snapshots rerender the owner while a dialog is open.
  // Keep these adapter identities stable so DirectoryBrowser's initial-load
  // effect responds only to `open` or `targetKey`, not to an unrelated poll.
  const listDirectory = useCallback((path?: string, signal?: AbortSignal) =>
    listDirectoryRef.current(path, signal), [])
  const createDirectory = useCallback((path: string, name: string) =>
    createDirectoryRef.current(path, name), [])
  return createElement(DirectoryBrowser, {
    targetKey: selectedHost,
    open: props.open,
    busy: props.busy,
    listDirectory,
    createDirectory,
    t: props.t,
    onOpen: props.onPicked,
    onClose: props.onCancel,
    header: createElement(HostPicker, {
      selectedHost,
      disabled: props.busy,
      onSelectedHost: setSelectedHost,
      t: props.t,
    }),
  })
}
