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
| M2 Agent layer ◆ | **done**; owner chose role defaults (sol: planner/tutor/grader; flash: generator/feynman/summarizer/researcher) | `bun test` 63 pass · grader A1–A10 PASS on sol · commits `4c1339e`…`a25f576` |
| M3 Server/API/dev console ◆ | **built; eval incomplete (stopped: owner's Codex usage limit hit)**. Driver, `sage serve`, API v1 frozen + schema, dev console, CLI. **STOP here for the owner's real Cram session.** | `bun test` 72 pass · `tsc` clean · server boots with real runtime · commits `da602b8`…`77d60d8` |
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

### M3: what exists
- `packages/agent/src/driver.ts` `SessionDriver`: reducer → ledger (rejected events are never stored) → effects; roles via host; tutor turns; researcher in the background; one automatic retry for a failed role call/tutor turn, then the effect is parked for `session.retry`; `resume` replays the ledger.
- `apps/server`: `startServer` (127.0.0.1 only, launch token with constant-time compare, Host/Origin must be loopback, one learner lease per session), `schema.ts` (API v1 method table = validator = `docs/api/v1.schema.json`), `console.ts` (throwaway dev console at `/`). `docs/API.md` is the frozen v1 doc; reserved methods answer `1003`.
- `apps/cli/src/sage.ts`: `serve [--port]`, `setup [--provider PKG]`, `login`, `update [VERSION|--rollback|--reset]`, `schema`, `models`. Sage's own agent dir only (see M3 review).
- `packages/eval/src/cram-eval.ts`: 5 Cram units (math, biology, history, Spanish, first aid = non-academic), simulated learner (flash, fixed knowledge profile), virtual clock, adaptive vs fixed baseline (real planner/generator/grader; deterministic non-adaptive tutor from `fake-runtime.ts`). Writes `eval/CRAM_EVAL.md`.

### Bugs the M3 eval found (all fixed, with regression tests)
1. `drain()` on an empty queue left a stale resolved promise → later grades never ran (sessions stalled in `grading`).
2. The Cram gate was unreachable: the tutor's `activity` tool had no `variation` field and generator banks had no variation items, so `changed_application` could never be observed (learner scored 100 on 30 straight items and never passed node 1).
3. Numeric keys were graded on the **first** number in a worked answer (`… = 96 - 20 + 6 = 82` graded as 24) → correct node-check answers scored 0.

### M3 all-flash eval (2026-11-07, `eval/CRAM_EVAL.md`), run from Sage's own agent dir
- Every role on antigravity/gemini-3.8-flash, budgets 90–120 min. Adaptive passed 7 nodes in budget across 5 units (aid 1/5, calc 2/4, esp 1/4, resp 2/5, ww1 0/4); baseline 0 in every unit (mean 39–57, ~25–30% of answers independent). No unit reached the mixed check. Cost $0.04–0.17/session-hour adaptive.
- Gate-based plan estimates were over budget in 4 of 5 units (only ww1 fit); ED-29 constants still need calibrating from real sessions.
- Fixes from this run (committed, with regression tests): flash grade quotes (looser quote match, validation inside the grader parse, retry that says what was rejected); rejected role output now retries then parks instead of hanging; the checkpoint move no longer dead-ends; tutor fallback and baseline tutor try every unused item; long digests trimmed; LaTeX backslashes in JSON replies repaired.
- Still open: flash grader sometimes returns no parseable JSON even after the retry (3× in the calc rerun), occasional tutor_failed, network errors (ENOTFOUND daily-cloudcode-pa.googleapis.com); ww1 (long-form history) passes nothing in 192 min. Researcher `submit_pack` and the key-check drop rate were not measured separately in this run.

### Flash grading (owner, 2026-11-08: "work on flash grading; keep sol; move to terra")
- **Output:** the grader now answers through a forced `submit_grade` tool call with a JSON schema (`roleCall({ output })`, toolChoice `required`; antigravity maps it to Gemini function-calling mode ANY, codex passes `tool_choice: "required"`). 0 parse failures in 240 flash calls at default reasoning, 1 (recovered by the retry) at high reasoning; free-form JSON broke braces/quotes in ~2 of 60.
- **Prompt:** a per-criterion decision order (absent/wrong → 0; right but loose → 1 + precision deduction; broader than required → 0.5) and conclusions must answer the exact question asked. Examples in the prompt are neutral (none taken from the anchors).
- **Calibration, flash default reasoning, 3 repeats:** A1–A10 MAE 7.3, signed +1.9, no ceiling violations → **PASS** (narrowly; earlier runs of the same setup ranged 7.0–8.8). C01–C20 MAE 11.7, signed −2.3. Residual misses are stable, not noise: A7 33 vs 55 (flash won't read "makes most of the energy as NADH" as saying Krebs makes little ATP) and A8 88 vs 65 (flash credits the shifted conclusion).
- **Tried and dropped:** high reasoning (no change; thinking hits the 4,096-token cap), a second-examiner review pass (A 6.8 but signed +3.4, double the calls), the owner anchors as few-shot examples (leave-one-out A 9.1 with A8 at 98).
- **C set for owner review:** C15's target 40 credits the classic misreading ("95% sure the true value is in the interval"), where flash gives 0; C04's stem is wrong (the function returns 1 for [1, 2, 3], not 0); C01/C14/C17/C07 targets sit below what the scoring formula can give a right-answer-wrong-reason response.
- **Defaults:** grader → flash; planner + tutor → `openai-codex/gpt-6.1-terra` (same API as sol, half the price). sol stays selectable per role in settings. sol's 5.5 was measured on the older prompt; neither sol nor terra has been run on the new one (needs `/login` for openai-codex in Sage's dir).
- **Cram eval rerun (all flash, adaptive):** calc 3/4 nodes in budget (was 1/4, then 2/4), 0 grader errors in 92 grades. ww1 0/5 because the tutor's open high-confidence hypotheses were never resolved (123 probes of one medium hypothesis). Engine fix d90cd18: graded probes resolve a hypothesis after 2 independent passes, mark it uncertain after 3 probes, and high-confidence ones are probed first. ww1 rerun after the fix: 1/4 in budget (node 1 at 60 min, node 2 at 127), mean 76; the tutor proposed no hypotheses that run, so the fix is unit-tested but not yet seen live.

### M3 eval status before the review changes (superseded)
- Run 3 hit "Codex error: The usage limit has been reached" 6× (the owner's openai-codex quota, which serves sol), plus the researcher's JSON failure every session. Numbers are contaminated; no unit passed a node within its 30-min budget. calc/adaptive passed its first node at 32 min (first real pass, after fixes 1–3).
- Across runs, adaptive vs baseline: adaptive learners scored higher (mean 62–94 vs 34–75) and far more of their answers counted as independent (~75–95% vs ~15–35%). Adaptive cost $0.20–0.78 per session-hour; baseline $0.02–0.25.
- Open, needs owner: (a) generated numeric keys are not verified (one calc key was wrong: 5 where the answer is 0) and deterministic items can't be disputed, so a wrong key can block a node. Options: allow `grade.dispute` on numeric/exact items (model re-checks key vs working) or a key-check pass per bank. (b) The planner makes 4–6 nodes for a 30-min Cram while a Cram node needs recall + explanation/selection + changed application at K=2 plus a 5-item check (~15+ learner-minutes/node): budget/plan size mismatch is a pedagogy call. (c) Researcher (flash) never returned parseable JSON in the eval; it's background-only but currently produces no packs. (d) Baseline's fake tutor sometimes can't act (`tutor_failed`), which shortens baseline runs; fix before the baseline comparison is quoted.

### M3 review changes (owner, 2026-11-07)
- **Isolation.** `sage setup` installs pi-web-access into `SAGE_HOME/agent` (plus provider packages only when named: `--provider npm:pi-antigravity@0.11.0` for gemini). `sage login` runs Sage's bundled pi against that dir for `/login`. `--pi-agent-dir` is removed; the app never reads ~/.pi. TMP/TEMP/TMPDIR and the npm cache are bound under SAGE_HOME. Verified: a fresh SAGE_HOME through setup → models → serve wrote nothing to ~/.pi, the npm caches, the temp root or the home root (pi's jiti/compile caches landed in `SAGE_HOME/tmp`). Real model calls from Sage's own dir verified by the all-flash eval after the owner's login there.
- **Key check (b).** Every generated numeric/choice/exact key is solved blind by the `checker` role (flash): the solver's arithmetic expression is evaluated in code when it gives one, else its answer is used. Disagreement or "ambiguous" → that item is regenerated once; still disagreeing → dropped. `packages/agent/src/keycheck.ts`.
- **Key disputes (a).** `grade.dispute` on an answer-key item (while its feedback shows) → grader re-checks key vs working. Wrong key → item voided (never evidence, never shown), all attempts re-scored against the corrected key (kept, not evidence), cue ladders dropped, replacement generated (`bank_generated` purpose `replace`). Key stands → notice with the reason.
- **Plan fit.** Node minutes come from the gate (ED-29 constants: per-dimension item minutes, chunk, node-check item, retry factor), not the planner. `plan.fit` at proposal/merge/pace/time changes: when over budget it offers extend to N min, `plan.merge` of adjacent pairs, or Speed-up, each with its estimate. Gate unchanged. ED-29 numbers are guesses to recalibrate from real sessions.
- **Researcher** returns its pack through a `submit_pack` tool call with a JSON schema (pi validates the arguments), not prose JSON. Untested live yet.
- **Flash as grader:** fails the A1–A10 gate at default reasoning (MAE 8.8) and at medium (MAE 8.7, signed −0.5). The misses are the same two anchors both times: A7 (target 55, flash 25) and A8 (target 65, flash 88). sol passes (MAE 5.5). High reasoning was started but stopped unfinished.

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

1. **Owner:** `bun run sage login` → `/login` openai-codex inside Sage's dir, so terra (and sol) are available. Until then, set planner/tutor to flash in settings for a session.
2. Calibrate terra and sol on the new grader prompt (`bun packages/eval/calibration/run-grader.ts openai-codex/gpt-6.1-terra 3`) and run a short terra planner/tutor eval (planner deadline at low reasoning).
3. Owner: review the C01–C20 targets flagged above; then recalibrate ED-29 from the owner's real session.

## Commands

```
bun install
bun test               # all unit + persona tests
bun run typecheck
bun run eval           # writes eval/REPORT.md
bun run eval:smoke     # persona tests only
bun run sage setup [--provider npm:pi-antigravity@0.11.0]   # packages into SAGE_HOME/agent only
bun run sage login                                          # pi /login inside SAGE_HOME/agent
bun run sage serve                                          # real session; prints the dev console URL
# real-model dev scripts use Sage's own agent dir; [REASONING=medium] for calibration variants
bun packages/eval/calibration/run-grader.ts antigravity/gemini-3.8-flash 2
EVAL_MODEL=antigravity/gemini-3.8-flash bun packages/eval/src/cram-eval.ts [calc,resp,…] [--adaptive-only|--baseline-only]
```
