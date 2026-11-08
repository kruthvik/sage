# Engine API v1.0.0 (frozen at the end of M3)

WebSocket JSON-RPC 2.0. `sage serve` binds `127.0.0.1` on a random port (or `--port`) and prints a launch token.
Connect to `ws://127.0.0.1:<port>/ws?token=<token>`. Requests whose Host or Origin isn't loopback on that port get 403, and a wrong token gets 401. The machine-readable contract is `docs/api/v1.schema.json` (`bun run sage schema`), served live at `/schema.json?token=…`; every method's params are validated against it before dispatch.

**Authority:** learner methods map to engine events whose emitter is `learner` in `EVENT_ACTOR` (`packages/engine/src/state.ts`), and the driver refuses anything else from a client. The model can never author learner responses, consent, approvals or source acceptance.
**Lease:** one client drives a session at a time. `session.create` takes the lease, `session.resume { takeLease: true }` takes it over, and closing the socket releases it. Read methods work without the lease.
**Errors:** `-32700` parse · `-32600` invalid request · `-32601` unknown method · `-32602` invalid params (message lists every problem) · `1001` engine rejected (message is the engine's reason) · `1002` lease held elsewhere · `1003` reserved, not implemented yet · `1004` unknown session.
**Events** arrive as `{"jsonrpc":"2.0","method":"event","params":{event, sessionId, data}}` to every client attached to the session: `tutor.done`, `item.present`, `grade.result`, `feedback.present`, `repair.required`, `hint.reveal`, `gate.update`, `node.status`, `pace.notice`, `confirm.required`, `plan.changed`, `plan.fit`, `notice`, `research.started`, `research.ready`, `cost.update`, `export.ready`, `checkpoint`, `error`, `dev.item_rejected`, `transcription.review` ({itemId, text}: show it editable; nothing is graded until `transcription.confirm`). An `error` event with `data.retry: true` means the session is waiting on a failed role call or tutor turn: call `session.retry`.

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
| `item.submit` | sessionId, text?, choice?, indices?, fields?, latencyMs? | learner (lease) | `indices`: ordering = choice indices in the learner's order; matching = target index for each choice. |
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
| `settings.get` | — | read | `roleModels`, `graderCalibration` (`provider/model` → calibration note, e.g. flash: "fails calibration: lenient on weak answers"), `exportFontPath`, `vaultPath`, `capabilities` (calculate available; graph and drawing unavailable in Phase 1, each with the reason) |
| `settings.set` | roleModels?, exportFontPath? (string or null), vaultPath? (string or null) | learner (lease) | `exportFontPath`: a local .ttf/.otf you have embedding rights for, used in PDF exports. Copy it into a plain folder such as `SAGE_HOME/fonts/`: system fonts (`C:Windowsonts`) are hard-linked and refused. null = built-in font (maths symbols printed as ascii). `vaultPath`: your Obsidian vault (absolute folder). Session folders are then written to `<vault>/Sage/sessions/` with YAML frontmatter and [[wikilinks]]; Sage never writes over a file it didn't write, and never reuses a folder it doesn't own. |
| `usage.get` | sessionId? | read | With sessionId: that session's spend. Without: `{enabled, sessions, hours, calls}`, or `{enabled:false}` when counters are off. |

## Reserved in v1 (answer `1003` until their milestone)

| Method | Params | Kind | Note |
|---|---|---|---|
| `turn.send` | sessionId, text | learner (lease) | free-text turn to the tutor (needs an engine event) |
| `image.consent` | sessionId, images: [{dataBase64}] | learner (lease) | scrap_work photos. Calling it **is** the learner's per-message consent to send these photos to the transcriber model (default flash), so the client must name the model and ask first. 1–4 PNG/JPEG/WebP (checked from the bytes), ≤ 5 MB each, ≤ 12 MB total; stored locally in `data/blobs/`. Emits `transcription.review`. |
| `transcription.confirm` | sessionId, text, latencyMs? | learner (lease) | The learner's checked (optionally edited) transcription. It becomes their response and is graded; the attempt records which photos it came from. |
| `export.get` | sessionId | read | regenerates the session folder (`SAGE_HOME/sessions/<date>-<topic>/`) from the ledger; returns `{dir, written, unchanged, userEdited, pdfs, errors, sessionMd}`. Files the learner edited are never overwritten (listed in `userEdited`). |
| `sources.add` | one of {name, dataBase64} · {url} · {title, text} · {notePath}; examSample? | learner | Files ≤ 16 MB: .pdf (text layer; scans and PDFs Sage can't parse go to local Windows OCR, ≤ 12 pages), .docx/.pptx (read from the XML, no Office needed), .png/.jpg (local OCR), .vtt/.srt, .txt/.md. `url`: a YouTube video (its public captions; YouTube often refuses without sign-in, and Sage says so) or a direct .vtt/.srt URL; only that URL is fetched, and private addresses are refused. `notePath`: a .md inside `vaultPath`, read only. Returns the source in `needs_review`. |
| `sources.preview` | sourceId | read | The record and its first 60 spans `{spanId, locator, text}` (p3, ¶12, slide 4, L1–40, 00:01:02–00:01:09). Excerpts are the source's text, so show them as data. |
| `sources.accept` | sourceId, shareWithModels | learner | `shareWithModels` is the learner's consent to send excerpts to the planner and generator models. `session.create` refuses `goal.sourceIds` that aren't accepted with it. |
| `sources.remove` | sourceId | learner | Blocks all future use (it can't be re-accepted; add it again to review a fresh copy). Past sessions keep their history. |
| `sources.list` | — | read | Current revision of every source. |
| `brain.get` | — | read | Phase 2 |
| `brain.set` | — | learner (lease) | Phase 2 |
| `usage.set` | enabled: boolean | learner | Local usage counters on/off (on by default; nothing is uploaded). |
| `extensions.list` | — | read | `{packages, notice}`: pi packages in Sage's own agent dir. The notice is always shown: extensions run with your OS privileges, and Sage's isolated home is not a sandbox. |
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
