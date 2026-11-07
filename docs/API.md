# Engine API (draft; freezes as v1 at the end of M3)

WebSocket JSON-RPC 2.0 on `127.0.0.1:<random port>`, authenticated with a launch token. The full method and event list is SPEC §17. This draft records only the parts that are settled. Requests for more surface go in `API_REQUESTS.md`.

**Authority:** every method below maps to an engine event whose emitter is fixed by `EVENT_ACTOR` (`packages/engine/src/state.ts`). Learner methods can only come from the client. The model can never author learner responses, consent, approvals or source acceptance.

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
