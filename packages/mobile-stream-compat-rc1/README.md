# DSH RC1 Mobile Stream Compatibility

This out-of-tree Host plugin implements the additive
`mobile-session-sync-v3` realtime/sync transport and legacy SSE compatibility
for native clients. The accepted v2 HTTP surface remains owned by the sibling
`mobile-session-sync-rc1` package and both packages must be loaded together
when v2 clients are supported. This package reuses the v2 projection/paging
semantics but deliberately does not register the v2 HTTP routes. It reads only
the official RC1 `sessionController` and `workspaceController` services; no
removed proxy service is required.

The sibling v2 package registers these routes:

- `GET /api/mobile.sessionSyncDescribe` negotiates the protocol and bounded paging limits.
- `POST /api/mobile.sessionSyncSnapshot` captures one server-owned notification baseline for every
  non-archived Session.
- `POST /api/mobile.sessionDelta` returns the continuous suffix after the last durably applied
  Session sequence. If the bounded scan cannot reach that sequence it reports `scanLimitReached`
  instead of returning a discontinuous suffix.

This package registers the v3 and compatibility SSE routes listed below.

All routes are loopback-only and do not change `dsh-core`. Initial history,
scan-limit recovery, and backward pagination call the official
`sessionController.follow/page` faces; the v2 routes own reconnect baselines
and strict incremental recovery while v3 adds bounded projection/detail reads.

## `mobile-session-sync-v3` wire contract

The v3 surface is deliberately an out-of-tree, read-only transport. It does
not add a core RPC method or depend on the removed proxy layer.

| route | request | response |
| --- | --- | --- |
| `GET /api/mobile/v3/describe` | none | protocol/capability and hard limits |
| `POST /api/mobile/v3/snapshot` | `{}` (an optional `rpcId` is echoed) | active sessions and authoritative/unknown watermarks |
| `POST /api/mobile/v3/delta` | `{sessionId, afterSeq, maxEvents?}` | converted contiguous event suffix |
| `POST /api/mobile/v3/history` | `{sessionId, beforeSeq?, maxMessages?}` | converted page; only this backward cursor is sent to core |
| `GET /api/mobile/v3/events` | `sessionId?`, `sinceSeq?` query | SSE `data:` records from the same converter |
| `GET/POST /api/mobile/v3/details` | `sessionId, seq, version, field?, offset?, limit?` | bounded UTF-8 detail chunk |

Without `sessionId`, the events endpoint replays current pending interactions and then delivers
only live events. It does not enqueue historical events across all sessions; use snapshot and
delta/history for ordered catch-up. A session-scoped subscription retains cached replay filtered
by its optional `sinceSeq`. Buffer overflow still closes the stream with an explicit control.

Requests with an `rpcId` receive a response with the same `rpcId`; callers that omit it receive
the value directly. Every v3 history/delta event has `sessionId`, `seq`, `time`, and `type`.
Unknown durable event types never carry their original payload: they are a shell only. Known
message events preserve text and public reasoning. Tool calls/results expose only an allow-listed
summary, failure category, and call id. Full arguments and results are always addressable
through `detailRef: {seq, version, field}`, including small arguments, streaming tool-call
deltas and tools embedded in messages. Default tool events contain neither inline arguments
nor raw-argument previews. Clicking a result returns its complete sanitized content through
bounded detail pages, without requiring clients to discover nested result references.
Normal message/reasoning text and the information needed for existing approval controls
keep their existing loading behavior. Details use an event sequence and version, not a
server-generated opaque id, and are paged by UTF-8 byte `offset`/`limit` (a cursor must land on a
code-point boundary).

Snapshot sessions are exactly one of:

```json
{"sessionId":"s-1","lastSeq":42,"authoritative":true}
{"sessionId":"cold","unknown":true,"authoritative":false}
```

`partial` is true when any session is unknown. History/delta return `lastSeqKnown:false` and omit
`lastSeq` when the live tail is not proven; they never turn that state into `-1`. Every converted
event has `{sessionId,seq,time,type}` and may add a safe `body`. The known control additions are:
`control/approval/requested|resolved` (`approvalId`, optional `callId`, `originSeq` nullable;
requested also has `requestRpcId`), and `control/question/requested|resolved` (`questionRpcId`,
`originSeq:null`; requested also has bounded question/options). `originSeq:null` is an explicit
unknown origin, not a tail guess.

The event page is capped at 128 converted events and 512 KiB.
Backward history keeps the newest suffix and uses its first sequence as
the next `beforeSeq`; forward delta keeps the oldest prefix and advances `afterSeq`. Core
`maxMessages` bounds append-origin user/assistant messages, not events, so a single core page
can exceed the mobile cap. Large text is referenced through the bounded detail index rather than
silently truncated. Approval/question requested
and terminal frames, plus goal/todo/model/permission durable events, remain visible through the
same conversion path. Approval controls carry `approvalId`, a stable pending request identity,
and `originSeq` from the durable `approval/asked` event when that event is already indexed;
otherwise `originSeq:null` is explicit. Question controls carry the mux `questionRpcId` and
`originSeq:null`: the core has no durable question event to which a sequence can be attributed.
The mux has no ready/end-baseline frame, so there is no reliable pending-history boundary. The mux
`session/subscribed.lastSeq` and subsequent `session/event.seq` frames are the live watermark
authority; cold sessions are probed one-at-a-time in the background. An unavailable cold tail is
`unknown:true`, never an invented `-1`; `-1` means an explicitly confirmed empty log only.

### Control and projection normalization

`session/queue` and `session/jobs` are not reduced to a count. Their bodies contain bounded,
allow-listed `items`/`jobs` snapshots, `count`, `complete`, and
`representation:"safe-projection"`. Queue messages retain stable message id, placement, role,
source and safe content needed for an existing edit/remove/claim RPC; jobs retain id, kind, label,
status and lifecycle times. The plugin does not invent mutation RPCs or claim wire-level parity
with every producer-private field: clients must use the existing Host mutation surface or refresh
after `complete:false`.

History/delta tail pages and `control/session-projection` carry the same `{asOfSeq,values}` shape
for the mobile-safe built-ins (`goal`, `todos`, `permissions`, `plan`, `title`, token/context
usage, session stats and image limits). Unknown/plugin projection keys are omitted. A
`request/header` event normalizes model state as `body.model` (provider/model/reasoning effort and
bounded sampling fields), optional `body.adapterDefaults`, and `body.reason`; `request/context`
uses `body.model` plus `contextWindow`. System prompts, tool schemas, replay state and unknown
payload members are intentionally not sent.

The mux watcher reconnects after an end/failure and emits a safe `control/stream-error` category.
Each subscriber has count and byte bounds; overflow is a terminal
`control/stream-overflow` with `action:"resync-delta"`, never a silent drop. Pending approval and
question controls are replayed from the process-local pending snapshot and removed on their
stable-id terminal event. Question `originSeq` remains `null` because the core has no durable
question event boundary.

Tool arguments are parsed and sensitive-key filtered before entering a detail record. Detail text
is bounded by a byte budget; oversized records keep only a reference/metadata in memory and are
reloaded from bounded `sessionController.page` reads when requested. A missing/reload failure is an
explicit detail error, not a silently truncated body.

Compaction events are projected with `compactionId`/`sourceCommandId`, summary content, shadowed
range/seqs/token count, provider/model and safe usage; `rawOutput` and unknown fields are omitted.
The compact checkpoint `user/message.source` retains the safe provenance
`{kind:"plugin",plugin:"compact",compactionId}` when present. `subagent/update` retains bounded
`agentId`, `name`, `status` and summary content. Goal changes and projections use the core field
`maxGoalRounds` (not a renamed `maxRounds`) together with `phase`/`blockedReason`.

Global transport controls such as mux/stream failures use `sessionId:""` so native decoders can
parse one stable event shape; clients must treat the empty id as host-global rather than a session.
The SSE writer honors Node backpressure (`write() === false`) by waiting for `drain`, close, or
abort before requesting another event, and removes the request listener on termination.
