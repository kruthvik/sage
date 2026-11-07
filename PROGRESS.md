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
| M2 Agent layer ◆ | **in progress**: pi adapter `sdk.ts` (1.5.0); calibration set (10 owner anchors + 20 unreviewed triples, 9 domains) + `calibrate()` harness; engine researcher hooks + Cram metrics | `bun test`: 51 pass · `tsc` clean · commits `c10e2c4`, `bd6f4dc` + calibration commit |
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

1. M2: finish `packages/pi-adapter`. Port v3 `packages/pi/src/{runtime,resources,plugins}.ts` (isolated agent dir, `PI_CODING_AGENT_DIR`, no ambient `.pi`/`~/.agents/skills`, telemetry off, auto-compaction off, `pi-web-access` provisioned (NOT pi-subagents: owner reply 2) under Sage's agent dir) and `planner.ts`'s `runBoundedPiChild` as the generic one-shot role transport (≤4,096 output tokens, 60 s, cancelable). Then `ui-bridge.ts`, covering the 27 `ctx.ui` methods listed under Owner decisions. Skip `shared-runtime.ts` (dropped).
2. M2: `packages/agent`: **domain-neutral** role prompts (planner decomposes *any* topic by what the learner must do, sets `knowledgeConfidence`, `proxyFor` for non-text skills; generator bank; grader with criteria-first partial credit + deductions from `DEDUCTION`; feynman; summarizer; **researcher** using `pi-web-access` tools `web_search` / `fetch_content` / `get_search_content` / `source_check`, which need a provider key (Brave/Exa/Tavily/Perplexity/Gemini/Jina), else unsourced fallback), context packet ≤12,000 chars with drill-down (port v3 `runtime/src/context.ts`), char/token accounting. Then `packages/sage-extension`: phase-scoped tools `context`, `select_move`, `present`, `propose`, `activity`, `request_research` + the short policy.
3. M2: run the real grader against `calibrate()` (`packages/eval/calibration/set.ts`) with MAE ≤8, mean signed error ≤ +3, nothing with target ≤85 at ≥95. Ask the owner to spot-check C01–C20 (written by Claude, unreviewed). Then M3: 5-domain Cram units (≥1 non-academic) for the simulated-learner eval.

## Commands

```
bun install
bun test               # all unit + persona tests
bun run typecheck
bun run eval           # writes eval/REPORT.md
bun run eval:smoke     # persona tests only
```
