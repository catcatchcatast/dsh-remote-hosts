# Contributing

Thank you for helping improve DSH Remote Hosts.

1. Search existing Issues before opening a new one. Use a focused issue for a
   bug, compatibility report, or feature discussion.
2. Branch from `main` and keep each change focused. Explain the user-visible
   behavior and compatibility impact in the commit and pull request.
3. Run `pnpm install --frozen-lockfile` and `pnpm run check` with the matching
   sibling DSH source tree. Add meaningful tests for changed behavior.
4. Complete the pull request checklist, including DSH compatibility, privacy,
   license impact, and screenshot redaction.

Contributions are accepted under Apache-2.0. Do not remove or relicense
third-party notices. Files copied or transformed from an upstream project must
preserve their original license and attribution. Original source files may use
`SPDX-License-Identifier: Apache-2.0` where a file header is appropriate.

Never publish tokens, keys, authorization URLs, real IP addresses, hostnames,
device serial numbers, session text, private logs, or unredacted screenshots.
Use `catcatchcatast@gmail.com` for sensitive reports and follow
[SECURITY.md](SECURITY.md).
