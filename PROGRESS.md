# Sage v4 progress

Read `docs/SPEC.md` first (the owner's Phase 1 brief). This file says where things stand.

## Setup

- Repo: `C:\Projects\sage\sage-v4` is a **git worktree** of `C:\Projects\sage\sage-v3` on orphan branch **`v4`** (no v3 history). v3 stays checked out at `../sage-v3` for porting.
- Carried over from v3 unchanged: `outputs/` (research corpus, read-only), `LICENSE`, `brain.md`, `scripts/check-publication.ts`, `.gitignore`.
- `.gitignore` fix: bare `sources/`, `data/`, `exports/` etc. are now root-anchored (`/sources/`). In v3 they silently ignored `packages/sources/src/{captions,pdf,office,raster,limits}.ts`.
- Nothing is committed yet (owner hasn't asked for commits). Branch `v4` exists with no commits; the first commit should be the whole M0–M1 tree.
- Toolchain seen: Bun 1.4.2, git 2.55, pi 1.5.0 is the latest published version (v3 pins 1.0.0), Ollama **not installed**.

## Milestones

| | Status | Verified |
|---|---|---|
| M0 Orientation ◆ | done; batch 1 answered | n/a (docs only) |
| M1 Pure engine + ledger | **done** | `bun test`: 36 pass · `tsc` clean · `bun run eval` all 6 personas, 0 reducer errors |
| M2 Agent layer ◆ | **done** except the owner's default-model answer: pi runtime + role transport + researcher session, `packages/agent` (grader, roles, host, packet, tutor), `packages/sage-extension`, `sage update` | `bun test`: 63 pass · `tsc` clean · grader calibration A1–A10 **PASS** on gpt-6.1-sol · live probe plan→bank→pack→tutor turn · commits `4c1339e`, `6c2c22c`, `38463fb` |
| M3 Server/API/dev console ◆ | not started | |
| M4 Exports | not started | |
| M5 Activities ◆ | not started | |
| M6 Integrations | not started | |

M0 outputs: `docs/SPEC.md`, `docs/V3_PORT.md`, `docs/RESEARCH_MAP.md` (24 mechanisms, 27 engineering defaults), `docs/DESIGN.md`, `docs/LIBRARY_CANDIDATES.md`.

### M1: what exists
- `packages/core/src/types.ts`: domain model (SPEC §6). Deviations: `SubSkill.kind` (declarative/procedural) and `selectionRelevant`; `requiredDimensions` is `Dimension[][]` (any-of groups, so Cram's "explanation **or** selection" is expressible); `Item.hints` holds the 3 hint levels; `ItemKey` union. `paths.ts` gives the `SAGE_HOME` layout.
- `packages/engine` (pure; no I/O, clock or randomness; IDs come from counters):
  - `loop.ts`: `reduce(state, event, now, actor)` plus `replay`. Covers plan DAG validation, bank intake with validation and cosmetic-family aliasing, prime → teach → check → grade → feedback ack → repair → adapt, the engine-run diminishing-cue ladder 3→2→1 then an uncued fresh family, node check (60/40, every gap rechecked, earlier failure ⇒ `needs_repair`), close/stopping point, the end-of-session mixed set, diagnostic (cap, skip ⇒ unknown, accelerate test-out), controls, dispute, hypotheses, pacing, review cards, spend.
  - `state.ts`: state shape, `EngineEvent` union, `EVENT_ACTOR` (who may emit what; this is the F10 enforcement), `Effect` union, `TOOLS_BY_PHASE`.
  - `evidence.ts`: dimension observation, gate (§8.1), quote-verified grades, coverage debt. `items.ts`: validator (§12.5), deterministic grading, leak and overlap checks. `candidates.ts`: ≤4 + checkpoint. `pacing.ts`, `scheduler.ts`, `pedagogy.config.ts` (every constant cites an RM/ED row).
- `packages/storage/src/ledger.ts`: v3's ledger core with the same 7 tables, triggers and idempotency. v3's `define`/`record` domain validation is dropped (the reducer replaces it). Engine events are stored as `v4.<type>` rows; `engineLog` + `replay` rebuild state. v3's component projection is replaced by the reducer, so there's no separate projection cache yet.
- `packages/eval`: `fixture.ts` (2-node unit, stub planner/generator/tutor/grader), `run.ts` → `eval/REPORT.md`, persona tests for each engine-owned F-row (F2, F3, F5, F6, F7, F8, F10, F12, F15), Speed-up invariants, supported ≠ independent, the misconception path, replay equality.
- `scripts/check-publication.ts`: now uses `core/paths.ts`. Its forbidden-path regex was root-anchored (it would have blocked `packages/exports`).

### Engine decisions made while building (inferable; flag if wrong)
- Gate condition 3 is strict: the **latest** non-repair graded attempt on a subskill must pass. A repaired failure still needs a later success.
- Any graded feedback marks that item's family as exposed. Later items in the family can't count as independent (v3's conservative contamination rule).
- Only model-graded responses can be disputed; MCQ and numeric keys can't.
- Blocking flaws force repair only for model-graded (open) responses. A wrong MCQ or number just gets corrective feedback, then the cue ladder.
- The tutor may present only `practice` items or validated ad hoc items. `teaching` items go in chunks as worked examples; `assessment` items are engine-only.
- A chunk that carries a worked example may run to 2× the word cap (`shortcut:` comment in `loop.ts`).
- Not yet built: blob store, backup/restore port, image/scrap intake (rejected until M5), node-check top-up when the bank has fewer assessment items than the check size (it uses what's there).

### M2: what exists
- `packages/pi-adapter/src/runtime.ts`: `createSageRuntime` builds one isolated runtime (Sage's agent dir, `PI_CODING_AGENT_DIR` bound, in-memory settings: telemetry off, compaction off, untrusted project; no skills, prompt templates, themes or context files). `roleCall` = one `ModelRuntime.complete` request, ≤4,096 output tokens, 60 s, cancelable; rejects tool calls, empty and truncated (`length`) replies; optional `reasoning` level (via `completeSimple`). `researchCall` = a pi session with only `web_search`/`fetch_content`/`get_search_content`, a blocking `tool_call` hook at 6/6, serialised. `tutorTurn` = a fresh pi session per turn with only the phase's Sage tools; isolation check rejects any other active tool.
- `packages/pi-adapter/src/update.ts`: `updatePi` (install to fresh `install-<uuid>` with `bun add`, validate exports, smoke, atomic `active.json` rename with `previous`), `rollbackPi`, `resetPi`, `loadPiWithFallback` (offline startup: a broken selection rolls back with a notice). CLI wiring comes with M3.
- `packages/agent`: `grader.ts` (model judges criterion credit 0/.25/.5/.75/1 + flaws; **code** computes the score: mean credit − precision on met criteria only (5–10) − min(polish, 4)); `roles.ts` (planner, generator, feynman, summarizer, researcher prompts + strict parsers, all domain-neutral); `host.ts` (`runRole`: effect → calls → events, one retry on unparseable JSON, node bank split into teaching 3 / practice 5 / assessment 4 so each call fits 4k output); `packet.ts` (12k cap, cacheable prefix, explicit omissions, never keys/rubrics, `drill(id)`); `tutor.ts` (`runTutorTurn`: one corrective retry, then a labelled deterministic fallback).
- `packages/sage-extension`: `SAGE_TOOLS` (context, select_move, present, activity, propose, request_research) as plain JSON Schema, and `TUTOR_POLICY` (~600 tokens).
- `packages/eval/calibration/run-grader.ts` and `packages/eval/src/live-probe.ts`: real-model dev scripts. Credentials: Sage's own agent dir by default; `SAGE_EVAL_AGENT_DIR=~/.pi/agent` is an explicit opt-in that reads the owner's pi dir **in place** (nothing copied) and loads only the packages for the named providers plus pi-web-access.

### M2 deviations (flag if wrong)
- **No `ui-bridge.ts`.** pi 1.5 has 42 `ctx.ui` methods (not 27) and a built-in no-op UI whose `hasUI()` is false. Extensions check `hasUI()` before opening dialogs; a bridge would make them think a user is present. Headless role and tutor sessions keep pi's no-op UI. Learner interaction goes through the engine API only.
- Role calls default to the provider's reasoning level. The planner runs at `reasoning: "low"` in the probe because gpt-6.1-sol at default took >60 s for a whole-unit plan (41–52 s at low). The grader keeps the default because that's what was calibrated.
- Tutor sessions are fresh per **turn**, not per node (spec: per node). The packet already carries the context; per-turn keeps input flat and cacheable. `shortcut:` upgrade to per-node if continuity suffers in the real session.

### M2 findings
- **Keyless web search works.** Live-probed with all `*KEY*`/`*TOKEN*` env vars removed: Exa MCP (pi-web-access's zero-config default in `auto` mode) ✓ 0.6 s; DuckDuckGo HTML ✓ 1.6 s (explicit `provider: "duckduckgo"` only); public degoog ✓ 2.3 s (explicit only). Content fetch has keyless paths too (local Readability, Jina Reader fallback, local `unpdf` for PDFs). So the researcher needs no key by default.
- **Grader calibration** (one run per triple ×2 repeats, `eval/CALIBRATION-*.md`):
  - gpt-6.1-sol: A1–A10 MAE 5.5, mean signed −1.4, no ceiling violations → **PASS**. C01–C20 (unreviewed) MAE 11.8, mean signed −0.1, C11 violates the ceiling → informational only. Cost $0.23 for 60 grades.
  - gemini-3.8-flash: A1–A10 MAE 8.8, mean signed +0.4 → **FAIL** (A8 +26, A7 −30). C01–C20 MAE 14.1. Cost $0.012 for 60 grades (~19× cheaper).
  - Biggest remaining misses on the A set: A7 (−22, grader won't credit the implied correction), A9 (+10).
  - The prompt fix that moved sol from FAIL (MAE 9.3, A8 +35) to PASS was general examiner reading of "specific", "follows from" and "clear claim", not anchor-specific text.
- Live probe ("Pass a beginner sourdough bread practical next week", sol planner + flash generator/researcher): 8-node plan with honest text proxies on every physical subskill; 12/12 bank items accepted by the engine validator after the prompt states the activity→evidence table and MCQ key shape; researcher returned 7 cited sources in 82 s (flash, keyless); first tutor turn reached. Whole run $0.04.

## Research findings worth knowing

- Nothing in `outputs/` contradicts a spec mechanism.
- Two spec **values** are in tension with the research or with each other (RESEARCH_MAP ED-05, ED-12): Speed-up's K=1 makes "≥2 families" impossible; Prime "on" in Cram goes beyond P2's procedural-only evidence.

## Owner decisions

(Answers to question batches go here, newest first. They override SPEC.md.)

- **Owner reply 2 (2026-11-07). Overrides SPEC where they conflict.**
  - **Grading rules:** criteria first (met / partly met / not met; partial credit for partly met). Deductions apply only to a *met* criterion worded imprecisely: **precision −7 typical (5–10; 10 for standard examiner deductions such as a missing +C, a wrong technical term, a vague location)**, **polish −1 (0–2), polish total capped at 4**. If the stem gives the answer away, repeating it earns nothing. Calibration adds: **mean signed error ≤ +3** (grader can't be lenient on average), on top of MAE ≤ 8 and no target ≤85 scoring ≥95.
  - **Anchors A1–A10 are final** (owner scores; mine were 10–25 too lenient on A2/A5/A7/A8/A9). The other ≥20 triples must span **≥6 domains**, including non-academic ones (language, programming, argument, music/chess principle, econ/stats, a procedural task). Each domain needs a right-answer-wrong-reason case and a precision-only case.
  - **Subagents:** no general-purpose subagents for the tutor; grading roles never get any. `pi-subagents` is **not** used. One dedicated **`researcher`** role is the only subagent:
    - Attached learner sources come first. Research fills gaps, flags conflicts, and never overrides the learner's material.
    - Triggers: (a) intake with no sources; (b) node start when sources don't cover the node; (c) planner marks the node `knowledgeConfidence: low`; (d) the blueprint names a specific exam/course; (e) the tutor's `request_research(question)`, its only research tool, which queues work rather than blocking.
    - Output: a source pack (title, URL/citation, relevance, spans, reliability note, node) → existing preview/accept flow; accept all in one click, or auto-accept if the learner turned it on in the preview.
    - Tools: an installed pi web search/fetch extension (`pi-web-access`). If none is available, say so and use model knowledge labelled unsourced.
    - Limits (ED-28): cheap/mid model, ≤6 searches, ≤6 fetches, token cap, runs in the background, cached per topic and node, cost logged.
    - API: `research.status`, `research.pack`, `sources.acceptPack`. Anything more goes in `docs/API_REQUESTS.md`.
  - **Commits:** commit at least once per milestone, in small commits. M0–M1 committed as `c10e2c4`.
  - **Scope:** domain-general (anything learnable). The example subjects are fixtures, not scope. No subject code paths. `calculate` key checks are an optional capability. The planner decomposes by what the learner must *do*. Be honest about modality (text proxies labelled as proxies). Eval: full Cram sessions on **≥5 units from different domains**, ≥1 non-academic.
  - **Priority:** single-session Cram efficiency. Primary metrics, shown first in `eval/REPORT.md` and `session.md`: share of nodes passed within the budget, time to pass each node, end-of-session mixed-check performance (assessment items), cost per session-hour. Learn/Drill/Accelerate stay as working presets with no extra features. Retention is the v3 baseline hook plus "predicted (unmeasured)" only. Keep the data model multi-session-compatible. Deferred work is listed in `docs/DEFERRED.md`.
- **M2 batch (2026-11-07)**
  - Pi: **pin 1.5.0**, and let users update whenever pi releases (`sage update`: install separately → offline startup check → atomic select → rollback). Verified: 1.5.0 exports `createAgentSessionRuntime/Services/FromServices` + `InteractiveMode`; `ExtensionUIContext` methods = select, confirm, input, notify, editor, setStatus, setWidget, setFooter, setHeader, setTitle, setWorking{Message,Visible,Indicator}, setHiddenThinkingLabel, pasteToEditor, set/getEditorText, set/getEditorComponent, addAutocompleteProvider, onTerminalInput, get/setTheme, getAllThemes, get/setToolsExpanded.
  - Extensions: **bundle `pi-web-access` for everyone** (source finding). **Include `pi-subagents`** (owner: "valuable"). **`pi-antigravity` is the owner's personal choice, not bundled**; it reaches his Sage home through `extensions.importFromPi`. Open point for the next boundary: whether subagents are enabled by default for the tutor. Default plan: phase-scoped (adapt/teach only), logged and cost-metered, because §12.1 role calls stay one-shot with no extensions.
  - Calibration: use the proposed anchor scores in `packages/eval/calibration/ANCHORS.md` **provisionally**. Calibration counts as passed only once the owner's scores are in.
  - Deductions (ED-25): **precision −5, polish −1** per flaw.
- **M0 batch (2026-11-07)**
  - Q1 Scheduler: **v3 transparent baseline** (2 d, ×2 on delayed success, reset on failure). No FSRS.
  - Q2 `/exam`: **folded into the exam blueprint** (Cram/Drill). Four modes only.
  - Q3 Models: **no Claude models as defaults** (owner: Claude only works inside Claude Code). Every role is user-selectable in settings. Defaults: planner + tutor `openai-codex/gpt-6.1-sol`; grader, generator, feynman, summarizer `antigravity/gemini-3.8-flash` (alt: `openai-codex/gpt-6-luna`).
  - Q4 Engineering defaults: **RESEARCH_MAP table approved as written**, including ED-05 (families ≥ min(K,2)) and ED-12 (Prime only for procedural subskills).

## Queued for later batches

- **M2**: pi version (pin 1.5.0, the owner's current, after checking exported APIs vs v3's 1.0.0); which of the owner's pi packages to bundle or recommend (`pi-web-access` for source finding is the obvious reuse; inventory below); ~10 grader calibration anchors; precision/polish deduction points.
- **M4**: pdf-lib vs Typst (after checking math/table rendering).
- **M6**: whether the untracked v3 `packages/sources` extractors ship; Ollama install + EmbeddingGemma tag; sqlite-vec on Windows.

Owner's pi packages (from `~/.pi/agent/settings.json`): pi-plan-mode, pi-agent-browser-native, pi-subagents, rpiv-ask-user-question, pi-antigravity, pi-lens, pi-powerline-footer, pi-web-access, browser-loop, pi-sdd-kit, pi-usage, pi-llama-cpp; local `herdr-agent-state.ts`, `pi-rtk-optimizer`. Providers with auth: openai-codex, github-copilot, antigravity, llama.cpp.

## Next 3 tasks

1. Owner: choose the default model per role (asked after M2). Then wire them as `RoleModels` defaults in settings (user-selectable, no Claude defaults).
2. M3: `packages/agent/src/driver.ts` (session driver: ledger append per event, effect loop, background researcher, tutor turns, learner actions) + `apps/server` (`sage serve`: loopback WebSocket JSON-RPC, launch token, tutor lease) + API v1 JSON Schemas frozen in `docs/API.md` + throwaway dev console + `sage update` CLI.
3. M3: simulated-learner eval on ≥5 Cram units from different domains (≥1 non-academic) with the real roles + fixed-baseline comparison; then STOP for the owner's real Cram session.

## Commands

```
bun install
bun test               # all unit + persona tests
bun run typecheck
bun run eval           # writes eval/REPORT.md
bun run eval:smoke     # persona tests only
# real models (dev opt-in; reads ~/.pi/agent in place, copies nothing):
SAGE_EVAL_AGENT_DIR=~/.pi/agent bun packages/eval/calibration/run-grader.ts openai-codex/gpt-6.1-sol 2
SAGE_EVAL_AGENT_DIR=~/.pi/agent STRONG=openai-codex/gpt-6.1-sol CHEAP=antigravity/gemini-3.8-flash bun packages/eval/src/live-probe.ts "<objective>"
```
