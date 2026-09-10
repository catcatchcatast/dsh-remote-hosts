# DSH Remote Hosts

Out-of-tree plugins that add multi-host access to DeepSeek Harness (DSH)
without modifying `dsh-core`.

The rc.1 compatibility layer keeps the original DSH web and desktop UI. It
routes workspaces, sessions, interactions, files, and terminal requests by
host-scoped resource identifiers, while SSH credentials remain on the
controlling computer.

## Compatibility

| DSH runtime | Support | Notes |
| --- | --- | --- |
| `0.1.2-rc.1` | Supported | Primary compatibility target. |
| Other `0.1.2` prereleases | Not claimed | Package and protocol seams can differ. |
| Newer releases | Untested | Revalidate injected UI and RPC contracts first. |

See [COMPATIBILITY.md](COMPATIBILITY.md) for package roles and protocol
requirements.

## Repository layout

- `packages/browser-host-hub-rc1`: browser-side routing and multiplexed streams.
- `packages/runtime-host-hub-rc1`: runtime aggregation for the rc.1 contract.
- `packages/rc1-host-carriers`: local and remote host carriers.
- `packages/ui-directory-picker-browse`: shared local/remote project picker.
- `packages/mobile-*-rc1`: Android-facing compatibility endpoints.
- `packages/subscriptions-compat-rc1`: local subscription and provider routing.
- `packages/model-menu-filter`: deployed model catalog filtering.
- `packages/ui-workspace-menu-compat-rc1`: deployed workspace menu and ordering patch.
- `compat/android-bootstrap-mobile-session-sync`: source for the existing
  Android bootstrap fallback used only with older hosts.
- `tests`: unit and integration tests with synthetic hosts and credentials.
- `config`: secret-free configuration templates.

## Build and test

Prerequisites: Node.js 24, pnpm 11, and a sibling checkout of the matching DSH
source tree:

```text
parent/
  dsh-core/
  dsh-remote-hosts/
```

The sibling checkout supplies DSH workspace packages referenced by the root
`package.json`; it is not modified by this project.

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run check
```

`check` builds the TypeScript/UI packages before running tests that verify the
release packer. The matching DSH source checkout is therefore required even
for a clean verification run.

## Installation

Read [INSTALL-PLAN.md](INSTALL-PLAN.md). Start from
[`config/host-profile.example.yml`](config/host-profile.example.yml), store
passwords or key passphrases in the platform credential store, and keep private
keys outside this repository.

## Security

Web listeners and SSH forwards bind to loopback. Browser code never receives
SSH keys, passwords, or arbitrary proxy targets. A changed host fingerprint is
a hard failure. Closing a client connection does not stop the remote DSH task.

## Releases

Source history does not contain plugin archives or routine build output.
Published archives belong in GitHub Releases with a version and SHA-256 entry;
see [RELEASES.md](RELEASES.md).

## License

MIT. See [LICENSE](LICENSE).

## Optional official-bundle regression

`tests/rc1-project-order.test.mjs` uses the menu-patched intermediate of the official rc.1 workspace UI
bundle. Set `RC1_BASELINE` to that intermediate file before running the test.
Without it the test reports an explicit skip, rather than reading a local
machine-specific path. Do not point it at a bundle that already has the project-order patch.
See the two-step transformation in [INSTALL-PLAN.md](INSTALL-PLAN.md).
