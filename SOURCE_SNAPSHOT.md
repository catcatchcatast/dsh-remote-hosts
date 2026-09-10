# Source snapshot

This publication tree was prepared from source commit
`590f355d4a6048e2c67ccad395c140c71ee190a4` on 2026-09-10.

The publication commit intentionally omits the original `.git` directory,
development branches, `.codex` change records, machine-specific acceptance
scripts, screenshots, runtime profiles, credentials, logs, and build artifacts.
Synthetic test fixtures use documentation-only hosts and example identities.

The isolated Android bootstrap fallback under
`compat/android-bootstrap-mobile-session-sync` comes from source commit
`6e71de56f55254044bd9021ab0c88e733d2803ae`; its original development history
and trace annotations are omitted.

## Updates in this publication

- Preserve successful per-host session lists across slow requests and reconnects,
  and deliver late lists without overwriting newer mutations.
- Replace eager per-session background followers with a single global event
  listener. Heavy history reads are bounded to two per host and one per session.
- Route background list refreshes through the existing scoped carrier.
- Keep expanded project sessions ordered by their latest update time.
- Refresh protocol, recovery and ordering regression tests.

Development revisions include targeted tests and a bounded desktop stability
observation. This does not certify every older server deployment or complete
Android background synchronization. Update compatible Android and server
adapters together; subagent failures remain session-local.
