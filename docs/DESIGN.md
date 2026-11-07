# v4 design notes

The spec (`SPEC.md`) is the design. This file records only the choices it leaves open.

## One event log, one reducer

- The engine is a pure `reduce(state, event, now) → { state, effects }`. Every learner action and every validated model proposal becomes an **engine event** before it touches state.
- Engine events are stored as v3 ledger `event` rows (kind `v4.<type>`, body = the event). That keeps the 7-table schema, hashing, op IDs and correction chains unchanged. A v3 database opens; its old events are ignored by the v4 reducer.
- `SessionState` = fold of that session's events. Replay is `events.reduce(reduce)`. A test asserts replay equals the live state (port of v3's replay/cache-equality test).
- Effects are plain data: `{ kind: "call_role", role, input }`, `{ kind: "present_item", itemId }`, `{ kind: "pace_notice", ... }`, `{ kind: "write_export", ... }`. The server runs them and feeds results back as events (`grade_received`, `bank_generated`, …). So a model can only change state by producing an event the reducer accepts.

## Who may emit which event

| Source | Events |
|---|---|
| Client (learner, via API) | `session_created`, `plan_approved`, `plan_edited`, `response_submitted`, `hint_requested`, `chunk_peeked`, `feedback_acked`, `grade_disputed`, `control`, `pace_set`, `time_extended`, `image_consented`, `transcription_confirmed` |
| Server after a role call | `plan_proposed`, `bank_generated`, `grade_received`, `digest_written` |
| Tutor tools (validated) | `move_selected`, `chunk_presented`, `item_presented`, `hypothesis_proposed`, `plan_edit_proposed` |
| Server clock | `tick` (carries `now`; used for idle and pace) |

The reducer rejects tutor events that would author learner work, consent, approval or source acceptance (F10). It does that by event type, so it can't be talked around.

## Package graph

`core` ← `engine` ← `storage` ← `agent` ← `pi-adapter` / `sage-extension` ← `apps/server`. `engine` imports only `core`, so it has no I/O. `eval` imports `engine` + `storage` and stubs `agent`.

## Deliberately left out (for now)

- No IRT/BKT/Elo ability estimate (U1: unranked; spec forbids pooled scores).
- No background scheduler process. Reviews are offered when a session opens.
- No separate per-mode code paths; `modes.ts` is a table.
