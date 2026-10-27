# DSH public plugins

This local release candidate targets DeepSeek Harness **0.2.1-rc.2** and Node.js 24. It contains three plugins:

| Package | Responsibility |
|---|---|
| dsh-runtime-interface | Official runtime boundary, shared host/file/session operations, browser adapters, and explicit parent/descendant pause behavior. |
| dsh-remote-hosts | One plugin entry combining remote host settings, SSH carriers, browser host hub, and the existing mobile transport backend. |
| dsh-fork-inbox-guard | Uses the interface boundary to keep inherited pending input out of newly forked execution. |

Only these three packages are installable release targets. Other packages/ directories are retained internal build inputs or synthetic regression sources, not additional plugins to enable. Do not enable the retired standalone rc1 plugins alongside dsh-remote-hosts.

## Install into a new profile

Use an installed official DSH 0.2.1-rc.2 CLI, Node.js 24, pnpm 11.19.0, and an accessible public npm registry. From the directory containing all three archives, provide **all three in one operation**. The interface is a required exact peer supplied once by the profile; remote and guard do not fetch a second nested interface copy.

Windows PowerShell, using a new empty configuration root and a store inside that profile:

    $env:DSH_HOME = Join-Path $PWD '.dsh-public-demo'
    $store = Join-Path $env:DSH_HOME 'profiles/web/.pnpm-store'
    dsh plugin --profile web add ./dsh-runtime-interface-0.1.0-rc.1.tgz ./dsh-remote-hosts-0.2.0-rc.1.tgz ./dsh-fork-inbox-guard-0.2.0-interface.1.tgz --ignore-scripts --node-linker=hoisted --store-dir "$store"

The profile-local store uses pnpm's native no-project-registration path and avoids its external store/project symlink requirement on Windows. It changes no global pnpm or proxy settings. The official CLI initializes this independent web profile; this install command does not start an application. Third-party ws/zod dependencies are resolved normally from the public registry. No machine node_modules is copied into the release.

Review the generated profile, then use the official CLI to start it on an unused local port; configure your own hosts/SSH aliases through the UI. No addresses, credentials, subscriptions, presets, real sessions, or model authorizations are bundled. Keep the prebuilt archives together; installing remote or guard alone without the interface peer is not the supported local-archive installation procedure.

## First initialization before starting a new profile

Only for a newly initialized profile with no existing interface epoch, generate a UUID **once** using the installed Node.js:

    node -e "console.log(require('node:crypto').randomUUID())"

Open the profile-local cordis.patch.yml under DSH_HOME/profiles/web. Its initial content is an empty YAML list. Replace that empty list with this official id-targeted configuration override, substituting the UUID just generated:

    - id: runtime-interface
      config:
        historyEpoch:
          datasetId: "PASTE-THE-ONE-TIME-UUID-HERE"
          sequenceFormatGeneration: 4
          generation: 1

For an existing patch list, merge this field into its runtime-interface entry and keep unrelated entries and settings. If a valid historyEpoch already exists, keep its dataset and both generations exactly unchanged and skip this initialization. This is persisted configuration, not a command to run at each boot; never regenerate it on upgrade. It uses the original interface Config and official profile patch mechanism. No extra initializer package or YAML runtime dependency is added.

A serving web page by itself does not prove plugin activation: verify runtimeInterface is active and fork-inbox-guard has no pending runtimeInterface dependency after starting the independent profile.

The interface and remote packages retain their existing bundle patches. The guard adds only the fork inbox isolation hook. Older runtime peer ranges have been narrowed to the verified 0.2.1-rc.2 line; no older-runtime compatibility claim is made for this release.

## Source and builds

The source tree includes the prebuilt client bundles and their relative source maps, plus the nine internal module inputs listed in packages/remote-hosts/module-sources.json. No complete official core runtime or machine node_modules tree is copied. One source-only official MIT test helper, tests/fixtures/load78-official-mock-adapter.mjs, remains with its adjacent load78-official-mock-adapter.LICENSE (DeepSeek copyright); it is not included in the three runtime tarballs. Install development dependencies using the declared pnpm 11.19.0 package manager, then run pnpm build. There is no frozen dependency lock in the authoritative current source snapshot: dependency resolution and a reproducible clean rebuild remain explicit release-review items rather than a claimed byte-identical build.

pnpm test runs public package structure checks. Synthetic original regression tests remain under tests/. UI fixtures require DSH_OFFICIAL_021_RUNTIME to point to a clean official runtime installation; the source-mode recall fixture additionally requires DSH_OFFICIAL_021_SOURCE to point to the corresponding official checkout. These are developer inputs, not automatic discovery of a user's profile.

## License

Self-authored project code is Apache-2.0, copyright 2026 DSH Remote Hosts contributors. Original third-party portions retain their licenses and attribution. Read LICENSE, NOTICE, THIRD-PARTY-NOTICES.md and LICENSES/ before redistribution.

Public packaging changes and provenance policy: docs/PUBLIC-CHANGES.md.
