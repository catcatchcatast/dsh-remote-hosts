# Release artifacts

Plugin archives are published through GitHub Releases rather than committed to
the source tree. Every release entry should contain:

| Field | Example |
| --- | --- |
| Version | `0.2.0` |
| Compatible DSH | `0.1.2-rc.1` |
| File | one generated package archive or Android bootstrap compatibility archive |
| SHA-256 | 64 lowercase hexadecimal characters |
| Source commit | Full Git commit identifier |

Generate a checksum on Windows with:

```powershell
Get-FileHash .\package.tgz -Algorithm SHA256
```

`tools/rc1-package-release.mjs` packages the formal rc.1 set after `pnpm run
build`. The separately versioned `dsh-mobile-session-sync-0.3.2.tgz` asset is
the Android client's legacy-host bootstrap fallback; its source is under
`compat/android-bootstrap-mobile-session-sync` and it is not part of the rc.1
profile.
