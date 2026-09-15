# Current source: DSH 0.1.5-rc.2 Preview

Use `release-profile.json` and `node tools/release-profile.mjs build` for the current package closure. Official runtime inputs must match exactly `0.1.5-rc.2`; prepare them with `tools/prepare-official-runtime.mjs`. Build an upstream workspace UI candidate with `tools/build-rc2-workspace-candidate.mjs`; retain its upstream license. Installation is profile-scoped through the existing managed service entry point, with previous packages and configuration available for rollback. Never modify `dsh-core` or copy private runtime profiles into this repository.

The existing GitHub `v0.1.2-preview` archives are older binaries, not rc.2 artifacts. A new public binary release has not been prepared by this source-only synchronization. The legacy instructions below document that older release and must not be applied unchanged to rc.2.

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
