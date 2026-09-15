# Candidate persona config migration

This candidate-only adapter bridges the `text` field used by the 0.1.2 persona row to the `prefix` field required by `0.1.5-rc.2`.

Run it with explicit source, target, backup, and runtime version:

```text
node apply.mjs --source <legacy-preset.yml> --target <candidate-preset.yml> --backup <legacy-backup.yml> --runtime-version 0.1.5-rc.2
```

The source must match the allowlisted legacy SHA-256. The target is replaced only when it is byte-identical to that legacy source; an already migrated target is accepted idempotently. The adapter does not edit the official runtime package or formal configuration.
