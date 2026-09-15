# DSH Remote Hosts

[简体中文](README.zh.md)

> **Current release: DSH 0.1.2 Preview**
>
> Compatible with DeepSeek Harness `0.1.2-rc.1`. DSH 0.1.5 adaptation is in progress; it is not supported yet, and no release date is promised.

DSH Remote Hosts is an out-of-tree remote-host and mobile compatibility layer for DeepSeek Harness (DSH). It lets the existing DSH web and desktop interface work with local and remote runtimes through one host-aware path, without modifying `dsh-core`.

[Download v0.1.2-preview](https://github.com/catcatchcatast/dsh-remote-hosts/releases/tag/v0.1.2-preview) · [Installation](INSTALL-PLAN.md) · [Compatibility](COMPATIBILITY.md) · [Android client](https://github.com/catcatchcatast/dsh-t-remote-android)

## Project advantages

- **Keeps the familiar DSH experience.** Local and remote projects use the existing project, session, model, approval, question, file, and terminal flows. The compatibility layer adds no upgrade-specific interface.
- **Keeps `dsh-core` untouched.** Version-specific behavior is isolated in external packages, making deployment and rollback easier to audit.
- **Uses one host-aware data path.** Local and remote resources carry explicit host identity, reducing wrong-host routing and cross-session pollution.
- **Reduces long-lived browser connections.** A page uses one multiplexed WebSocket for supported logical subscriptions while ordinary requests remain HTTP.
- **Avoids eager cold-history recovery.** Mobile synchronization listens once per host and reads history when a cursor gap must be filled or a user opens a conversation.
- **Contains failures.** Stream, session, and host failures are handled at their own boundary instead of resetting unrelated work.
- **Keeps credentials out of the browser.** SSH credentials and host identity checks stay on the controlling computer; remote DSH endpoints remain bound to loopback.

## Feature list

| Feature | What it does | 0.1.2 Preview |
| --- | --- | --- |
| Multi-host workspace aggregation | Presents local and remote workspaces in one DSH navigation model while retaining host ownership. | Available |
| Host-scoped resource routing | Routes workspace, session, terminal, file, and interaction requests using composite host/resource identifiers. | Available |
| Local and remote project picker | Adds host-aware directory browsing to the existing new-project dialog, including directory creation and host switching. | Available |
| Browser stream multiplexing | Carries workspace/session follow streams and global events over one WebSocket per page. | Available |
| Session lifecycle controls | Preserves create, open, rename, branch, archive, cancel, steer, queue, and reconnect behavior. | Available |
| Approval and question compatibility | Preserves approval context, cross-client resolution, structured questions, skipping, and free-text answers. | Available |
| Mobile global event feed | Delivers new events for non-archived sessions without opening one follow stream for every conversation. | Available |
| Bounded history recovery | Reads cold history only for an opened session or a confirmed sequence gap, with at most two host-wide recovery jobs. | Available |
| Tool detail on demand | Sends safe tool summaries by default and exposes complete parameters, output, and diffs through detail references. | Available |
| Model and subscription adaptation | Adapts the rc.1 model catalog, selection state, provider routing, and local subscription presentation used by this release. | Available |
| Workspace menu parity | Aligns project/session menus and orders projects and sessions by recent activity. | Available |
| Failure and generation isolation | Rejects stale connection generations and prevents one stream or host failure from contaminating another. | Available |
| Release packaging | Produces versioned TGZ files, SHA-256 sidecars, source manifests, provenance, licenses, and notices. | Available |

The exact interface and failure semantics are recorded in [COMPATIBILITY.md](COMPATIBILITY.md) and the architecture decisions under [`docs/adr`](docs/adr).

## How it works

```text
DSH Web / Desktop
       |
       | HTTP requests + one multiplexed WebSocket
       v
Browser Host Hub
       |
       +---- Local carrier --------------------------> Local DSH runtime
       +---- SSH carrier + loopback forwarding -----> Remote DSH runtime
       +---- Mobile compatibility endpoints --------> DSH Android client
```

Composite host/session/workspace identifiers take precedence over a page's current host selection. Disconnecting a page or mobile client closes its connections without stopping the DSH task on the target computer.

## Current release

| Item | Value |
| --- | --- |
| Release | `v0.1.2-preview` |
| Compatible DSH runtime | `0.1.2-rc.1` |
| Status | Preview / prerelease |
| Project license | Apache-2.0 |
| Official workspace UI transform | Retains the upstream license and notices |
| Core modification | None |

Other DSH release candidates may use different package names, injection points, or protocol shapes. Treat them as unsupported until the compatibility suite and manual smoke checks pass against that exact runtime.

## Next release work

The next published work focuses on DSH 0.1.5 compatibility:

- adapt host carriers, stream transport, mobile endpoints, model selection, and interaction contracts to the confirmed 0.1.5 interfaces;
- preserve the current user-visible project, session, approval, question, cancellation, and tool-detail behavior;
- publish a new compatibility table, tested package set, provenance record, and rollback instructions after validation.

DSH 0.1.5 is not supported by the current packages. No additional product features or release date are announced.

## Getting started

1. Confirm that the DSH runtime is exactly `0.1.2-rc.1`.
2. Read [INSTALL-PLAN.md](INSTALL-PLAN.md) before changing a profile.
3. Download the current release and verify every required asset against its `.sha256` sidecar.
4. Start from [`config/host-profile.example.yml`](config/host-profile.example.yml).
5. Keep passwords, private keys, passphrases, OAuth material, authenticated URLs, and real host details outside the repository and profile template.
6. Restart DSH through its existing managed entry point, then verify local and remote browsing, streaming, cancellation, approvals, and reconnect behavior.

The preview is distributed as individual compatibility packages rather than a one-click installer. The release manifests identify package roles, inputs, source hashes, and licenses.

## Repository map

| Path | Purpose |
| --- | --- |
| `packages/browser-host-hub-rc1` | Browser routing and multiplexed logical streams. |
| `packages/runtime-host-hub-rc1` | Host aggregation for the rc.1 runtime contract. |
| `packages/rc1-host-carriers` | Local and SSH-backed remote carriers. |
| `packages/ui-directory-picker-browse` | Host-aware project directory selection. |
| `packages/mobile-*-rc1` | Android bootstrap, event, history, interaction, and detail compatibility. |
| `packages/subscriptions-compat-rc1` | Subscription and provider routing for the published profile. |
| `packages/model-menu-filter` | Model catalog filtering. |
| `packages/ui-workspace-menu-compat-rc1` | Workspace menu behavior and activity ordering transforms. |
| `compat/android-bootstrap-mobile-session-sync` | Legacy-host bootstrap fallback embedded by the Android client. |
| `config` | Secret-free configuration templates. |
| `tests` | Synthetic protocol, routing, recovery, packaging, and UI-transform tests. |
| `docs/adr` | Architecture decisions for transport and mobile detail loading. |

## Build and test

Prerequisites are Node.js 24, pnpm 11, and a sibling checkout of the matching DSH source tree:

```text
parent/
  dsh-core/
  dsh-remote-hosts/
```

The sibling checkout supplies referenced DSH workspace packages and is not modified by this project.

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run check
```

The optional official-workspace regression needs an unmodified rc.1 UI input. See [INSTALL-PLAN.md](INSTALL-PLAN.md) for the two-step transformation and baseline hash.

## Security and privacy

- Remote DSH listeners bind to `127.0.0.1` and are reached through authenticated SSH forwarding.
- SSH host fingerprint changes are hard failures.
- Browser code never receives SSH private keys or arbitrary proxy targets.
- Send, approve, create, and other write operations are not replayed automatically after a disconnect.
- Public issues must not contain tokens, keys, authorization URLs, real IP addresses, hostnames, device identifiers, private logs, or conversation text.

Use [GitHub Issues](https://github.com/catcatchcatast/dsh-remote-hosts/issues) for ordinary support. Send private logs and security reports to `catcatchcatast@gmail.com`; see [SECURITY.md](SECURITY.md) and [SUPPORT.md](SUPPORT.md).

## Releases, contribution, and license

Generated archives stay in [GitHub Releases](https://github.com/catcatchcatast/dsh-remote-hosts/releases) with SHA-256 sidecars, provenance, `LICENSE`, and `NOTICE`. Contribution rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

Project-owned code is licensed under Apache-2.0. Third-party components retain their original licenses. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Search terms: DeepSeek Harness, DSH, remote hosts, remote plugin, multi-host, SSH, Tailscale; DSH 远程插件, DeepSeek Harness 远程主机.