# @deepseek-ai/dsh-client-ui-directory-picker-browse

English | [中文](README.zh.md)

In-app directory browsing surface: the browser half of the browse picking interaction. It fills ui-workspace's two directory-flow holes (`conversation.hero.workspace.directoryFlow` and `sidebar.workspaces.directoryFlow`) with the New Project dialog, driving the selected Host's rc1 directory-list and create-folder primitives through `ctx.uiWorkspace`. The Host choice is scoped to this dialog and handed to browser-host-hub's page-local routing; no fixed global entry is added. Its node counterpart is [`dsh-host-directory-picker-browse`](../../host/directory-picker-browse/README.md); mounting this package composes the surface with that backend from one cordis.yml row, so no client code branches on a capability kind. Unlike the [`-native`](../ui-directory-picker-native/README.md) surface, the dialog needs no local operating-system chooser, so it also serves in-process and remote-browser deployments.

The dialog is a 644×735 Codex-style project card clamped to the viewport. Its header carries optional owner controls, filesystem-root shortcuts, a source-folder label, an Up action, and an always-visible absolute path that switches to direct editing. One scrollable directory level is visible at a time: the current level remains readable while its selected child is scanned, then the child replaces it in one frame. **New folder** creates under the selected folder; **Add Project** adopts the selected folder, falling back to the listed level. Host-flagged hidden entries stay hidden until the footer toggle reveals them, which is a client-side filter only.

Confirming a directory is the picked path and dismissing the dialog is the cancellation. A multi-Host owner may override the listing and creation calls, provide project and Host controls, and supply a stable target key; changing that key remounts the browser and aborts the previous scan. Rerenders that keep the same target key retain the current directory even when the owner replaces callback objects during Host-status polling. Browse failures — an unreadable target, a create conflict — stay inside the dialog's own alert surfaces, so this occupant never drives the owner's `onError` arm; the owner keeps the workspace-creation error surface. Both registrations install through nested `slots.inject()` calls because either declaring entry may activate later or replace its declaration, and the dialog's copy is registered in this package's own locale namespace: the two dictionaries land as a unit, so a failed activation cannot squat one locale of the namespace.

The node half is an empty `apply`: it exists so the plugin appears in the host cordis.yml and Loader, while the browser half ships through `exports["./client"]` and is discovered through the `dsh.client` manifest declaration.

## Model Experience

None, as the directory browser is browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No search, no multi-select, and no rename or delete** — the dialog lists and creates directories; a target is reached by navigating, editing the path, or filtering the last pane by prefix.
- **Hidden-entry filtering is client-side** — the Host always lists hidden entries and flags them, so the toggle changes only what the dialog renders.
