# Current source: DSH 0.1.5-rc.2 Preview

Use `release-profile.json` and `node tools/release-profile.mjs build` for the current package closure. Official runtime inputs must match exactly `0.1.5-rc.2`; prepare them with `tools/prepare-official-runtime.mjs`. Build an upstream workspace UI candidate with `tools/build-rc2-workspace-candidate.mjs`; retain its upstream license. Installation is profile-scoped through the existing managed service entry point, with previous packages and configuration available for rollback. Never modify `dsh-core` or copy private runtime profiles into this repository.

## Public 0.1.5-rc.2 entry

The `v0.1.5-rc.2-preview.1` prerelease publishes a self-contained entry package. It embeds the 12 project-owned runtime packages selected by its patch, so pnpm does not resolve their private workspace names from npm:

```powershell
dsh plugin --profile web add "https://github.com/catcatchcatast/dsh-remote-hosts/releases/download/v0.1.5-rc.2-preview.1/dsh-remote-hosts-0.1.5-rc.2.tgz"
```

Before first boot, merge [`packages/public-install-rc2/profile.patch.example.yml`](packages/public-install-rc2/profile.patch.example.yml) into the target profile's `cordis.patch.yml`. Replace `datasetId` with a stable identifier for that host's persisted session dataset. `sequenceFormatGeneration` is `3` for this adapter generation; start a new deployment at `generation: 1`. Preserve all three values across ordinary restarts. A deliberate data-baseline replacement must use a new dataset/generation value and requires clients to obtain a new baseline.

Host addresses, SSH credential references, model accounts, and authenticated URLs stay in the user's external configuration or credential store. Configure remote targets after installation; keep each target runtime on loopback and verify its SSH fingerprint independently.

Rollback removes the bundle entry and leaves external host/session data untouched:

```powershell
dsh plugin --profile web remove dsh-remote-hosts
```

The transformed official Workspace UI archive is separate. It retains the upstream license and exact-version provenance, and the entry package does not install or replace it.

### Isolated acceptance performed for the public entry

- Prepared the exact `@deepseek-ai/dsh` `0.1.5-rc.2` official closure in a new directory.
- Installed the entry with the real `dsh plugin --profile web add` path, which delegates to pnpm with a hoisted profile layout.
- Confirmed that the archive contained every declared project-owned dependency plus its LICENSE/NOTICE and that all bridge modules imported.
- Started DSH from the new profile with a synthetic persisted history dataset identifier; an unauthenticated request returned HTTP 401.
- Stopped the process and confirmed the assigned loopback port was released.

The npm installer emitted existing official peer-resolution warnings but completed with exit code 0. The acceptance did not use a user's DSH home, profile, credentials, sessions, or fixed service port.

The existing GitHub `v0.1.2-preview` archives are older binaries, not rc.2 artifacts. The earlier `v0.1.5-rc.2-preview` release contains the component package set without this verified single entry. The legacy instructions below document the older 0.1.2 line and must not be applied unchanged to rc.2.

---

# Installation and deployment

## Legacy 0.1.2 binary instructions — not for current rc.2 source

### 1. Match the runtime

Use DSH `0.1.2-rc.1`. Do not mix plugin bundles from another release candidate.
Build the repository against a sibling checkout of the matching DSH source.

## 2. Configure the controlling host

Copy `config/host-profile.example.yml` into your DSH profile patch and replace
the example metadata. Configuration contains credential references only.
Passwords, passphrases, private-key contents, OAuth tokens, and authenticated
bootstrap URLs must not be written into the profile.

Enable the rc.1 host hub, carrier, browser hub, directory picker, and mobile
compatibility packages needed by your deployment. Keep existing DSH UI packages
enabled; these plugins adapt their contracts instead of replacing the product UI.

## 3. Configure each remote host

Run DSH on a loopback address and expose it only through the authenticated SSH
carrier. Verify the server fingerprint before enabling automatic reconnect.
The remote process must keep running when the controlling page disconnects.

## 4. Validate

Run `pnpm run check`, then verify local and remote project browsing, session
creation, message streaming, cancellation, approval, and reconnect behavior.
Confirm that an unauthenticated request to the local DSH address is rejected.

## 5. Package

Package only the built plugin directories required by the target profile. Put
the archive in GitHub Releases and record its SHA-256 in the release notes. Do
not include host profiles, private keys, credential stores, runtime logs, or
authenticated URLs.

## Workspace UI menu and ordering bundle

The workspace menu compatibility package contains build-time transformers.
Installing it alone does not modify the official UI bundle. Start with an
unmodified `@deepseek-ai/dsh-client-ui-workspace` `0.1.2-rc.1` `lib/client.js`
whose SHA-256 is
`53c40660195c42cde709b802e239f473dd721f45bc329684af31c01fdb73282a`.
Create the ignored `.tmp/workspace-ui/` directory and copy the matching official
bundle there as `client.original.js`. Run these two steps from this repository:

```powershell
node packages/ui-workspace-menu-compat-rc1/src/patch-client.mjs ./.tmp/workspace-ui/client.original.js ./.tmp/workspace-ui/client.menu.js
$env:RC1_BASELINE = (Resolve-Path ./.tmp/workspace-ui/client.menu.js).Path
node --test tests/rc1-project-order.test.mjs
node packages/ui-workspace-menu-compat-rc1/src/patch-project-order.mjs ./.tmp/workspace-ui/client.menu.js ./.tmp/workspace-ui/client.js
```

The scripts reject unsupported or already transformed inputs. Include the
resulting `lib/client.js` in the matching official UI package used for deployment;
the compatibility-script archive is not a replacement for that UI package.
Preserve a rollback copy, replace the intended package, and restart through the
existing service entry point. Keep compiled UI archives in Releases, outside
source history.

<!-- 变更追溯：CHG-20260916-145608-public-install-entry-aeb49531；记录：.codex/doc/change-history/CHG-20260916-145608-public-install-entry-aeb49531.md -->
