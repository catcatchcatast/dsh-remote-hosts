# Release artifacts

The current public release line is `v0.1.2-preview`, targets DSH
`0.1.2-rc.1`, and must be published as a GitHub prerelease rather than Latest.
The current installable preview release is `v0.1.5-rc.2-preview.1`, targeting DSH `0.1.5-rc.2`; it is a prerelease, not Latest. Its `dsh-remote-hosts-0.1.5-rc.2.tgz` archive is the self-contained public entry. The earlier `v0.1.5-rc.2-preview` release retains the component package set. Final DSH 0.1.5 compatibility is not claimed. Existing `v0.1.2-preview` assets retain their original compatibility and hashes.

Plugin archives are published through GitHub Releases rather than committed to
the source tree. Every release entry should contain:

| Field | Example |
| --- | --- |
| Version | `0.2.0` |
| Compatible DSH | `0.1.2-rc.1` |
| File | one generated package archive or Android bootstrap compatibility archive |
| SHA-256 | 64 lowercase hexadecimal characters |
| Source commit | Full Git commit identifier |
| License | Apache-2.0 project license or the component's accurate third-party license |
| Notices | `NOTICE` and required third-party attribution |

Generate a checksum on Windows with:

```powershell
Get-FileHash .\package.tgz -Algorithm SHA256
```

`tools/rc1-package-release.mjs` packages the formal rc.1 set after `pnpm run
build`. The separately versioned `dsh-mobile-session-sync-0.3.2.tgz` asset is
the Android client's legacy-host bootstrap fallback; its source is under
`compat/android-bootstrap-mobile-session-sync` and it is not part of the rc.1
profile.

Release notes must link the source commit, list every asset and SHA-256, state
whether a package transforms an official DSH component, and include `LICENSE`
and `NOTICE`. Questions use GitHub Issues; private logs and security reports go
to `catcatchcatast@gmail.com`.

For the public entry, the release gate additionally verifies installation through `dsh plugin --profile web add` in a new profile, import of every bundled bridge, a real `0.1.5-rc.2` DSH Web boot, HTTP 401 without authentication, and process/port release after stop. The transformed official Workspace UI remains a separate upstream-licensed artifact.

<!-- 变更追溯：CHG-20260916-145608-public-install-entry-aeb49531；记录：.codex/doc/change-history/CHG-20260916-145608-public-install-entry-aeb49531.md -->
