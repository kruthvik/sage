# Engine API v1.0.0 (frozen at the end of M3)

WebSocket JSON-RPC 2.0. `sage serve` binds `127.0.0.1` on a random port (or `--port`) and prints a launch token.
Connect to `ws://127.0.0.1:<port>/ws?token=<token>`. Requests whose Host or Origin isn't loopback on that port get 403, and a wrong token gets 401. The machine-readable contract is `docs/api/v1.schema.json` (`bun run sage schema`), served live at `/schema.json?token=…`; every method's params are validated against it before dispatch.

**Authority:** learner methods map to engine events whose emitter is `learner` in `EVENT_ACTOR` (`packages/engine/src/state.ts`), and the driver refuses anything else from a client. The model can never author learner responses, consent, approvals or source acceptance.
**Lease:** one client drives a session at a time. `session.create` takes the lease, `session.resume { takeLease: true }` takes it over, and closing the socket releases it. Read methods work without the lease.
**Errors:** `-32700` parse · `-32600` invalid request · `-32601` unknown method · `-32602` invalid params (message lists every problem) · `1001` engine rejected (message is the engine's reason) · `1002` lease held elsewhere · `1003` reserved, not implemented yet · `1004` unknown session.
**Events** arrive as `{"jsonrpc":"2.0","method":"event","params":{event, sessionId, data}}` to every client attached to the session: `tutor.done`, `item.present`, `grade.result`, `feedback.present`, `repair.required`, `hint.reveal`, `gate.update`, `node.status`, `pace.notice`, `confirm.required`, `plan.changed`, `plan.fit`, `notice`, `research.started`, `research.ready`, `cost.update`, `export.ready`, `checkpoint`, `error`, `dev.item_rejected`. An `error` event with `data.retry: true` means the session is waiting on a failed role call or tutor turn: call `session.retry`.

## Methods (implemented)

| Method | Params | Kind | Note |
|---|---|---|---|
| `session.create` | goal | learner (lease) |  |
| `session.list` | — | read |  |
| `session.resume` | sessionId, takeLease? | read |  |
| `session.retry` | sessionId | learner (lease) | re-run the role call or tutor turn that failed (error.data.retry = true) |
| `session.end` | sessionId | learner (lease) | checkpoint + release lease (engine control.stop) |
| `plan.get` | sessionId | read |  |
| `plan.edit` | sessionId, plan | learner (lease) |  |
| `plan.approve` | sessionId | learner (lease) |  |
| `plan.merge` | sessionId, nodeIds | learner (lease) | before approval: merge nodes into the first listed (`plan.fit` suggests groups) |
| `diagnostic.skip` | sessionId | learner (lease) |  |
| `control.teach` | sessionId | learner (lease) |  |
| `control.morePractice` | sessionId | learner (lease) |  |
| `control.advance` | sessionId | learner (lease) |  |
| `control.leaveWithGaps` | sessionId, confirmToken? | learner (lease) |  |
| `control.stop` | sessionId | learner (lease) |  |
| `control.resume` | sessionId | learner (lease) |  |
| `item.submit` | sessionId, text?, choice?, fields?, latencyMs? | learner (lease) |  |
| `hint.request` | sessionId, level | learner (lease) |  |
| `chunk.peek` | sessionId | learner (lease) |  |
| `feedback.ack` | sessionId, attemptId | learner (lease) |  |
| `grade.dispute` | sessionId, attemptId, argument | learner (lease) | model grades any time; answer-key items while their feedback shows. A wrong key voids the item, re-scores its attempts (not as evidence) and replaces it |
| `pace.set` | sessionId, pace | learner (lease) |  |
| `time.extend` | sessionId, minutes | learner (lease) |  |
| `reviews.consent` | sessionId, subskillIds | learner (lease) |  |
| `state.get` | sessionId | read |  |
| `context.inspect` | sessionId | read | dev: the tutor packet as it would be built now |
| `research.status` | sessionId | read |  |
| `research.pack` | sessionId, packId | read |  |
| `sources.acceptPack` | sessionId, packId, itemIds? | learner (lease) |  |
| `settings.get` | — | read |  |
| `settings.set` | roleModels? | learner (lease) |  |
| `usage.get` | sessionId? | read |  |

## Reserved in v1 (answer `1003` until their milestone)

| Method | Params | Kind | Note |
|---|---|---|---|
| `turn.send` | sessionId, text | learner (lease) | free-text turn to the tutor (needs an engine event) |
| `image.consent` | sessionId | learner (lease) | M5 |
| `transcription.confirm` | sessionId | learner (lease) | M5 |
| `export.get` | sessionId | read | M4 |
| `sources.add` | — | learner (lease) | M6 |
| `sources.preview` | — | read | M6 |
| `sources.accept` | — | learner (lease) | M6 |
| `sources.remove` | — | learner (lease) | M6 |
| `sources.list` | — | read | M6 |
| `brain.get` | — | read | Phase 2 |
| `brain.set` | — | learner (lease) | Phase 2 |
| `usage.set` | — | learner (lease) | M4 |
| `extensions.list` | — | read | M6 |
| `extensions.install` | — | learner (lease) | M6 |
| `extensions.enable` | — | learner (lease) | M6 |
| `extensions.disable` | — | learner (lease) | M6 |
| `extensions.update` | — | learner (lease) | M6 |
| `extensions.importFromPi` | — | learner (lease) | M6 |
| `ui.respond` | — | learner (lease) | no pi dialogs reach the client (pi no-op UI) |

## Research (owner reply 2)

The `researcher` is the only subagent. It runs in the background: none of these calls block teaching.

| Method | Params | Result | Engine event |
|---|---|---|---|
| `research.status` | `{ sessionId }` | `{ running: {trigger, nodeId?, question?}[], packs: {id, trigger, nodeId?, status, items: number, conflicts: number}[], searchAvailable: boolean }` | none (read) |
| `research.pack` | `{ sessionId, packId }` | `SourcePack` (`packages/core/src/types.ts`): items with title, url/citation, relevance, spans, reliability note, nodeId, conflictsWithSourceId, unsourced | none (read) |
| `sources.acceptPack` | `{ sessionId, packId, itemIds? }` (omit `itemIds` = accept all) | `{ status }` | `research_pack_accepted` (learner) |

Events: `research.started { trigger, nodeId? }`, `research.ready { packId, items, conflicts }` (maps to the engine's `research_ready` notice).

Triggers (engine-owned, deduplicated per topic/node): intake with no learner sources; node start with uncovered node; planner `knowledgeConfidence: "low"`; blueprint `exam.name`; tutor tool `request_research(question)`.
Auto-accept happens only when the learner turned on `preview.toggles.autoAcceptResearch`.
`searchAvailable: false` means no web search/fetch extension is configured: research continues from model knowledge, and every item is `unsourced: true`.

## Plan fit (`plan.fit`)

Sent with every plan proposal, merge, pace change or time extension before approval: `{estMin, budgetMin?, fits, speedUpMin, mergeMin, mergeGroups, text?}`. Estimates come from what each node's gate demands (required dimensions, K, prime, node check), not from the planner. When `fits` is false, the client offers the three options: `time.extend` to `estMin`, `plan.merge` for each of `mergeGroups`, or `pace.set` `speed_up`. The gate is the same in every option.
