# DSH Remote Hosts public entry

This package is the public installation entry for the DSH Remote Hosts
0.1.5-rc.2 preview. Its archive embeds the project-owned plugin closure so the
target package manager does not fall back to unpublished workspace names.

The bundle activates the remote-host routing, browser stream, directory,
mobile compatibility, subscription compatibility, and model-filter packages as
one DSH plugin. Host addresses, credentials, and SSH configuration remain
outside the package.

The native [DSH T-remote Android client](https://github.com/catcatchcatast/dsh-t-remote-android)
is a companion project and is not embedded in this package.

The separately published transformed official Workspace UI archive retains its
upstream license and is not silently substituted by this package.

Install the release archive into a DSH `0.1.5-rc.2` profile:

```powershell
dsh plugin --profile web add "https://github.com/catcatchcatast/dsh-remote-hosts/releases/download/v0.1.5-rc.2-preview.1/dsh-remote-hosts-0.1.5-rc.2.tgz"
```

Before the first boot, merge `profile.patch.example.yml` into that profile's
`cordis.patch.yml`. Replace the example `datasetId` with a stable identifier for
that host's persisted session dataset. Keep it unchanged across ordinary
restarts; use a different value for a different host. Then start the profile
through its normal managed entry point.

Remove the entry package to roll back its bundle activation:

```powershell
dsh plugin --profile web remove dsh-remote-hosts
```

<!-- 变更追溯：CHG-20260916-145608-public-install-entry-aeb49531；记录：.codex/doc/change-history/CHG-20260916-145608-public-install-entry-aeb49531.md -->
