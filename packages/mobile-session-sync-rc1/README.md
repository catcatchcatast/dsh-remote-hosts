# dsh-mobile-session-sync-rc1

Bounded rc1 adapter for the existing v2 mobile HTTP routes. It uses the
official `sessionController`/`workspaceController` faces, pins each delta to a
`session.follow` snapshot cursor, and expands official packed chunk records
without assuming a dense numeric sequence across records.

The routes remain loopback-only and also pass the rc1 Connection trust/auth
fence. A malformed or unsupported history record, a truncated page, or a
stalled page cursor returns `baselineRequired` instead of silently dropping
events. Android transport integration is not included or claimed here.

Install the package into an rc1 Host bundle with the package's `cordis.patch.yml`.
No build step is required; the package entry is ESM JavaScript.
