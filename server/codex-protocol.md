# Codex protocol boundary

`codex.ts` targets the **installed Codex 0.162.1** protocol, inspected with
`codex app-server generate-ts --experimental`. Generated files were used as
reference and are not runtime dependencies. The gateway exposes only the
normalized types in `shared/protocol.ts`, never arbitrary JSON-RPC.

The adapter connects by WebSocket over the configured **existing Unix socket**.
It never starts an app-server, copies sessions, or treats rollout logs as a live
connection. Initialization opts into experimental APIs. Plan mode is enabled
only if `collaborationMode/list` advertises it. A passive `thread/resume` does not
override permissions, cwd, model, or approval routing.

History first uses `thread/items/list`. The running 0.162.1 shared server was
observed returning `-32601: thread/items/list is not supported yet`, despite the
generated schema containing it. Only that method-not-found error enables the
compatibility path: `thread/turns/list` with `itemsView: "full"`, ten turns per
page. Wrapped cursors prevent mixing turn and item pagination. Other errors are
propagated. Runtime turn identity comes from resume, notifications, or
`thread/turns/list`. Active input uses `turn/steer` with an exact
`expectedTurnId`. Timeouts and disconnects never retry mutations. Model values
sent to Codex use `model/list`'s `model` slug, not the catalog `id`.

A newly created thread is not materialized until its first user message. The
live 0.162.1 server returns an exact `-32600` condition for history on such a
thread; the adapter treats it as empty only when fresh metadata also says idle.
The same empty thread cannot yet be joined by another backend client:
`thread/resume` returns `no rollout found for thread id ...`. That error is not
suppressed and a passive subscription never starts a turn to work around it.
The live acceptance script therefore records a separate primary-only warmup
turn before subscribing its peer, then checks actual peer streaming on a new
marker turn. These are two distinct checks, not interchangeable evidence.

During a real first turn, `thread/turns/list` also briefly returned exactly
`-32601: list_turns is not supported yet`; the same persisted thread later
reported `historyMode: "paginated"` and both full and summary listing succeeded.
For only that precise condition, the adapter uses the verified
`thread/read(includeTurns: true)` for the current read, validating full item
data. Full-read pages use stable item anchors; native cursors are never guessed
or translated. The next ordinary snapshot tries native pagination again.
An unavailable history read is not represented as empty successful history.

History persistence can lag notifications that arrived before a snapshot
request. The adapter keeps a separate, generation-scoped overlay for live
items and turn state. A stale matching item cannot shorten live text, and
missing live items remain visible in their current history page. History
releases the item overlay only once its content/status covers the live value;
all reads already in flight at confirmation retain protection until they finish,
regardless of request order. Cached older
history pages do not create overlays. Disconnect clears them so resume rebuilds
state from the shared backend. Started/completed turn notifications likewise
protect active/idle state until both thread metadata and the corresponding
runtime history agree; the two backend reads need not catch up simultaneously.
When a parent turn is interrupted or failed, child items that still report
`inProgress` inherit that terminal status for display, while their output and
already completed results remain intact. This applies to notifications and
historical turn pages, including late child notifications after termination.

Approval identifiers are scoped to one socket generation. Disconnect and
`serverRequest/resolved` invalidate them, and concurrent responses lock locally.
Permission approvals grant only the requested permissions, for one turn.
JSON-RPC responses have no response acknowledgement: `{ sent: true }` means the
reply was written, not that execution succeeded. Later events are authoritative.

This version exposes **no pending-request list API**. Recovery requires the
shared server to replay unresolved requests when resuming. If runtime flags say
the thread is waiting but no request has been forwarded, the snapshot explains
that the user must handle it on the computer. That behavior and shared
Desktop/CLI control require live verification; transport mocks cannot prove
them. Authentication, attestation, and unsupported plugin calls are left to the
computer host rather than guessed or automatically approved.

`tests/codex.test.ts` checks protocol shapes, source listing, passive resume,
pagination, streaming/read races, start/steer separation, reconnect approval
replay, stale requests, exact permission grants, and mutation ambiguity using an
injected in-memory transport. Run with `node --import tsx --test tests/codex.test.ts`.
