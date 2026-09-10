# Compatibility contract

This snapshot targets DSH `0.1.2-rc.1` and does not modify `dsh-core`.

| Area | Required behavior |
| --- | --- |
| Browser transport | One multiplexed WebSocket per page for logical streaming subscriptions; ordinary RPC remains HTTP. |
| Resource routing | Composite host/session/workspace identifiers take precedence over a page default. |
| Project picker | Local and remote hosts share the existing project dialog and directory flow. |
| Mobile events | One global listener per host; cold histories are not followed eagerly. Gap recovery and user-open reads have bounded concurrency. |
| Mobile history | Conversation text loads normally; complete tool parameters and output are fetched on demand. |
| Approvals | Existing approval behavior is preserved and necessary decision context remains available. |
| Failure isolation | A stream, session, or host failure must not contaminate unrelated resources. |

DSH package names and injection seams are prerelease interfaces. Treat every
other release candidate as incompatible until the tests and a manual smoke test
have passed against that exact runtime.

The publication workspace contains only the packages used by the rc.1 release
and its deployed follow-up fixes. Earlier prerelease prototypes are excluded.
The isolated `compat/android-bootstrap-mobile-session-sync` package is retained
solely because the Android client embeds that fallback for older hosts; it is
not loaded by the formal rc.1 profile.
