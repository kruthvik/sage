# Sage v4 spec — Phase 1 (engine + backend)

> Owner's build prompt, saved verbatim-in-substance so later agents (pi) can continue. Section numbers (§) are referenced from every other doc. Decisions made after this was written live in `PROGRESS.md` ("Owner decisions") and override this file where they conflict.

## 0. How to work
- **Ask** before deciding anything in §20.1, at milestone boundaries (◆), in batches ≤4 questions, 2–4 options each, recommendation marked. Keep building what isn't blocked.
- **Infer** file/module layout, naming, test structure, lint, error types, logs, dev-console copy, anything trivially reversible.
- **Decided** (§2.1): don't re-ask.
- **Research grounding**: every pedagogical mechanism traces to `outputs/` (written under `outputs/research-contract.md`). Unsupported parameter → `ENGINEERING_DEFAULT`, propose a value, add to ask list. Never fabricate a citation.
- **Tokens**: index the ~600 KB corpus (headings, grep, targeted reads); don't bulk-load.
- **Don't repeat v2/v3**: v3 is rigorous but overloaded (7 tutor tools + render_ui + learning_skill, ~40 CLI subcommands, 23 KB caveat README; dense negation-heavy policy prose). v4 keeps v3's rigor **in host code** and gives the model a **short, positive, procedural** policy. If the engine can enforce a rule, it does and the prompt doesn't mention it. Unsure about a mechanism → leave it out, note it in `docs/LIBRARY_CANDIDATES.md`.

## 1. Failures to fix (each needs an eval check, §18)
| # | Failure | Root cause | v4 mechanism | Eval check |
|---|---|---|---|---|
| F1 | Lenient grading (85→100) | tutor grades own student | separate grader role, minimal context, rubric, quoted deductions, no persona (§12.4) | grader calibration set |
| F2 | Skips topics; can't cover a unit | v3 planner caps 3 components / 1–4 activities | planner maps whole unit into a node DAG; engine owns node transitions (§9) | plan ≥ expected node count; no advance unless gate passed |
| F3 | Barely tests; walls of text | no teach→check rhythm, no caps | every chunk followed by a check; chunks capped | every chunk followed by item; chunk ≤ cap |
| F4 | Questions too easy vs exams | no exam anchor | exam blueprint + per-node item bank with difficulty ladder to exam level (§6, §9) | difficulty/format distribution matches blueprint |
| F5 | Questions leak answers; empty prompts | weak pre-display validation | item validator + deterministic key verification (§12.5) | leak checker passes on 100% shown items |
| F6 | Learner copies back the chunk | check reuses chunk wording | transformed checks; chunk collapses during check | lexical overlap < threshold |
| F7 | No struggle / unsupported struggle | hints too free | hints only on request; diminishing cues after failure; uncued retry later (§7.3) | no unrequested hints; uncued retry after cueing |
| F8 | Diagnostic longer than teaching; assumes knowledge | no cap | capped skippable diagnostic; skip ⇒ **unknown** (§10) | duration; nothing unconfirmed assumed known |
| F9 | Too many tools; studio overused | every tool every turn | phase-relevant tool advertising; studio necessity criteria (§7.5, §12.3) | tools per phase; studio use logged with reason |
| F10 | Context mixes learner/AI | learner text via model channel | learner input only as host-captured event | role-integrity test |
| F11 | Expensive; context struggles | long transcripts | char-capped packet, ID drill-down, fresh pi session per node, manual-only compaction (§12) | per-turn budgets hold |
| F12 | Loses track of plan | no persistent "what am I doing" | SessionState + structured decision log | state always valid; "Now" block present |
| F13 | Pi update/dependency trouble | Sage tried to *be* pi | pi pinned behind one adapter; check-then-select update (§13) | all pi imports via adapter |
| F14 | Policy too long/negative ⇒ under-tests | rules in prose | short positive procedural policy | policy ≤ ~2.5k tokens |
| F15 | Precision flaws don't cost marks | v3 "precision doesn't subtract" | precision flaws **deduct**; only blocking forces repair (§8.4) | calibration has wording-flaw anchors |
| F16 | Session files mixed | flat export dirs | one folder per session, subfolders by type (§14) | layout test |

## 2. Principles
1. Model proposes, engine decides (validates, applies, owns all state).
2. Evidence dimensions, not points: acquisition, independent recall, explanation, method selection, execution, changed application, retention. More activities never inflate them.
3. Small core, opt-in library. No technique quotas, no forced rotation.
4. Every model call compiled, bounded, role-specific.
5. Learner controls pace and plan. Engine warns; learner chooses. Nothing cut without approval.
6. Strict and honest: 85 stays 85; wording flaws deduct; unseen criteria `not_observed`; software checks ≠ learning efficacy.
7. Everything readable: ledger is truth; Markdown regenerated from it.
8. Pi is a dependency, not a template.

### 2.1 Decided (do not re-ask)
- Name **Sage**; command `sage`; home `SAGE_HOME` default `~/.sage` (v3 used `~/.learn` → one-time migration offer).
- Engine first (headless + eval); GUI later (Tauri 2 + Bun sidecar).
- Gate is evidence-based (§8), not a points threshold.
- Grader is a separate, token-efficient model call.
- Modes: **Cram** (primary; absorbs fast-learn), **Learn**, **Drill**, **Accelerate**. Main use: a full unit in one 3–4 h session; long-term retention second.
- Pacing user-guided: non-blocking pace notice after a response; Normal / Speed up / extend time. Never cut nodes without explicit approval (avoid even then). Speed up loosens gates, compresses teaching.
- Model tiers configurable per role.
- Extensions: run pi-coding-agent SDK headless so unmodified pi extensions load; bridge `ctx.ui` to the client; Sage tools ship as a pi extension.
- Hints graduated, on request only, each level costs evidence (§7.3).
- In scope: cheat sheets md+PDF, diagrams/visual sims via activity DSL, Obsidian, usage tracking, video ingest. Deferred (hook only): voice recall.
- Usage tracking: local counters only (total sessions, total hours), on by default, visible toggle, nothing uploaded.
- Activity DSL: v3's indentation DSL → official A2UI basic catalog; optional `---js` module off until learner opts in (`packages/runtime/src/ui/compiler.ts`, `resources/skills/ui/SKILL.md`). Extend, don't replace.
- Research lives in `outputs/`.

## 3. Read first; write `docs/V3_PORT.md` (keep / rewrite / drop / ask)
Defaults — **Keep**: SQLite ledger (7 tables, WAL, migrations, content hashes, stable op IDs, correction chains) + rebuildable projection with sequence/time cutoffs; assistance semantics (offered/requested/exposed/possibly-exposed, answer-bearing vs not, record-before-reveal, feedback contaminates dependent steps, viewing a key ⇒ supported); exposure families + cosmetic-variant fingerprint; transfer variation contract; revisioned competing hypotheses; ≤4 next-move candidates + checkpoint with reason codes; decision log rejecting hidden CoT; phase-relevant tool advertising; char-capped context packet with ID drill-down; Feynman child contract; MCQ hidden keys; scrap-work image intake (consent, vision check, learner-confirmed transcription); capability registry (calculate, graph, drawing); UI DSL compiler, trusted shell, JS opt-in; md→PDF worker (pdf-lib); vault import; usage counters; OS-lock tutor lease; pi isolation; pi update with offline startup check + atomic selection/rollback; backup/restore into fresh home; `check:publication`; `brain.md` template.
**Rewrite**: planner policy (whole unit DAG); tutor policy (short, positive); learn-flow+gate → node loop + dimension gate; cram/drill/accelerate → mode presets over one loop; item banks; grading → grader role; new: pacing, session folders, cheat sheets.
**Drop/ask**: ~40-command CLI → GUI settings + `sage doctor` + `sage update`; per-opening studio approval → host-checked criteria (§7.5); slash commands as primary UI; seven subject profiles as code paths → keep `registerSubjectAdapter` registry, subjects become planner hints; separate `/exam` mode → fold into exam blueprint for Cram/Drill (**ask**); v3 two-day doubling vs FSRS (**ask**, §8.2).

## 4. Research protocol
Read order: `research-contract.md` → `learning-science-final.md` (esp. *Minimal learner-state model*, *Testable next-action rules*) → `synthesis/ideal-all-in-one-learning-system.md` → `synthesis/15-evidence-gaps.md` (Established/Plausible/Disputed/Unknown) → `evidence/02…08` sections as needed → `main.md` (rationale, not evidence). `learning-science.md` / `-draft.md` superseded.
Constraints to honor: no universal mastery/success threshold, fading trigger or interval (every number in §7–§11 is `ENGINEERING_DEFAULT`); low-success retrieval without feedback can fail, diminishing cues beat both (E1); practice performance ≠ learning (E3); fade on component-level independent evidence (P1); productive failure = generation then instruction, conditional, procedural (P2) ⇒ Prime optional; feedback timing context-dependent (D1); interleave only after basics, when selection is a target, score selection separately (D2); transfer = define what changed, cues, delay (D4); spacing: transparent fixed baseline first (P3); Cram: test-matched practice, report short horizon separately.
Outputs: `docs/RESEARCH_MAP.md` (`mechanism | v4 parameter | value | source + section/ID | tier | status` with status SUPPORTED/PARTIAL/ENGINEERING_DEFAULT/CONTRADICTED); `packages/engine/src/pedagogy.config.ts` with each constant pointing to its row. Research contradicts the spec ⇒ stop and ask. Strong mechanism outside core ⇒ `LIBRARY_CANDIDATES.md`.

## 5. Architecture
```
apps/server (sage serve)   apps/devconsole (throwaway)
packages/core  engine (PURE reducer, no I/O/models/clock)  storage  agent  pi-adapter (ONLY pi importer)
         sage-extension  activities  capabilities  sources  exports  integrations  eval
docs/  outputs/ (read-only)  templates/sage-extension/
```
One Bun process `sage serve`: engine + storage + roles + pi adapter; WebSocket JSON-RPC on 127.0.0.1, random port, launch token. Commands: `sage`, `sage serve`, `sage doctor`, `sage update`. Single-tutor lease = v3 OS-backed SQLite lock. Engine: `(state, event, now) → (state', effects[])`; `now` explicit; effects are host requests (call grader, present item, pace notice, write export); replayable from ledger.

## 6. Domain model (sketch; reconcile with v3 contracts)
```ts
type Mode = "cram"|"learn"|"drill"|"accelerate";
type Dimension = "acquisition"|"recall"|"explanation"|"selection"|"execution"|"changed_application"|"retention";
Goal { objective; mode; pace: "normal"|"speed_up"; timeBudgetMin?; horizonDays?; exam?: ExamBlueprint; allowedAids; accommodations?; learnerParams? (≤2000 chars); preview: LearningPreview }
ExamBlueprint { formats: ("mcq"|"short"|"free_response"|"problem"|"essay"|"oral"|"practical")[]; topicWeights: {nodeOrSubskillId; importance: high|medium|low}[]; timing?; gradingCriteria?; sampleSourceIds? }
LearningPreview { profile: balanced|cram|thorough|custom; toggles: {diagnostic,hints,studio,diagrams,fsrs,pdfCheatsheets,obsidianExport,reviewBeforeAdvance}; feedbackRigor: rigorous|focused }
Plan { rev; nodes; edges: [string,string][]; approvedAt? }
Node { id; title; order; prerequisites; subskills; examWeight; misconceptionsToProbe; estMinutes; status: locked|ready|active|gated|passed|tested_out|needs_repair|left_with_gaps; digest? }
SubSkill { id; nodeId; statement; requiredDimensions }   // per mode (§10)
Item { id; nodeId; subskillIds; activityType; difficulty 1..5; partition: teaching|practice|assessment; familyId; fingerprint;
  variation?: { baselineItemId; changedDimensions: (surface|representation|context|cueing|format|structure)[]; invariant };
  evidences: Dimension[]; stem; key?; rubric?; distractorRationales?; validated; keyVerifiedBy?: calculate|model|none; sourceSpans? }
Attempt { id; itemId; responseEventId (host-captured only); assistance; independent; grade?; isRepair; cueLevel 0..3; latencyMs }
Grade { score0to100; criterionEvidence: {criterion; satisfied; quote}[]; flaws: {quote; problem; suggestion; severity: blocking|precision|polish}[]; dimensionsObserved; feedback (≤60 words); grader: deterministic|model; disputed? }
Hypothesis { id; subskillId; category: conceptual|procedural|selection|representation|prerequisite|slip|unknown; statement; confidence low|medium|high; supportingAttemptIds; contradictingAttemptIds; status open|resolved|uncertain }
SessionState { activeNodeId; loopPhase; currentItemId?; openHypothesisIds; coverageDebt; candidates (≤4 + checkpoint); nextIntendedMove (≤30 words, "Now"); timeUsedMin; timeBudgetMin?; nodesPassed; nodesTotal; spend }
Decision { policyVersion; candidateIds; selectedId; reasonCodes; targetSubskillIds; evidenceIds; learnerOverride? }
```
Tutor proposes hypotheses, nextIntendedMove, candidate selection via tools; engine validates and owns everything else. Coverage debt names untested independence, retention, changed application, narrow family sampling; shown in "Now".

## 7. Activities
Registry: `ActivityType { id; label; core; responseShape; grading: deterministic|rubric_model; canEvidence; renders: native|dsl; whenToUse }`.
**Significance = which dimensions an activity can establish**, not numeric weights.
| Core type | Can evidence | Notes |
|---|---|---|
| free_recall (closed-book short answer) | recall, acquisition; retention if delayed ≥1 day | failure → diminishing cues |
| explain_why / Feynman inversion | explanation | curious-novice follow-up; grader scores explanation separately |
| apply_problem | execution; changed_application if variation w/ pinned baseline | keys verified by `calculate` where possible |
| conceptual_mcq | selection; explanation only if followed by a "why" | every distractor maps to a named misconception |
| find_the_error | explanation, selection | critique a flawed solution |
| method_choice | selection | which approach and why, without solving; scored separately (D2) |
| scrap_work (photo/typed working) | execution | vision + per-message consent; learner confirms transcription before scoring |
Library (opt-in by criteria): contrasting cases, ordering, matching, labeling/hotspot, plot/graph, parameter sim, concept map, vocab — map each to research.
**Hints**: Nudge / Strategy / Worked step; on request only; cost shown first. Nudge non-answer-bearing (validator checks no key terms) ⇒ attempt stays independent, assistance logged. Strategy & Worked step answer-bearing ⇒ `supported` (counts to acquisition, not independent dims). Each recorded `possibly_exposed` **before** reveal. After failed recall/application: diminishing cues strongest→weaker→**uncued retry on a fresh item later in the node** (only the uncued retry can be independent). Peeking a collapsed chunk = Nudge if chunk lacks the answer, Strategy if it contains it. Tutor never volunteers a hint; after struggle signal (long latency, two failures) may *offer* one in a single line.
**Feynman**: one cheap one-shot call → `{follow_up, gaps:[{quote,issue,probe}], strengths, uncertainty}` + explanation-dimension grade; learner sees only `follow_up`; no second grader call; child never scores mastery in learner text.
**Studio** allowed when (a) interaction native/chat can't capture (ordering, plotting, labeling, sim), (b) learner asked, (c) diagram/sim is the representation change after failure. Host checks + logs reason; no numeric cap; supplementary/preview use needs learner approval; tables/calculators/multiple fields alone ≠ necessity.
**DSL**: v3 two-space indentation DSL → A2UI v0.9 basic catalog; ≤32 KB source, ≤128 components, ≤12 nesting; `---js` off until learner clicks "Run custom code"; trusted shell copies only declared input fields. Extend with `mcq`, `numeric` (tolerance), `ordering`, `matching`, `hotspot`, `mermaid`, `plot` (graph capability), `slider` bound to plot, KaTeX `math`. Ask before more. Browser-side feedback/scores are never evidence.

## 8. Scores and gates
**STM = dimension coverage.** A dimension is observed for a subskill when an **independent** attempt on a **validated, not-previously-seen-family** item with a quote-backed grade ≥ pass mark (ED 80) claims it. Subskill passes when: (1) all required dims observed; (2) ≥K distinct independent checks across ≥2 exposure families (Cram K=2, Learn K=3); (3) latest attempt isn't an unresolved failure (blocking flaws repaired); (4) no `open` + `high` hypothesis. STM% = share of required dims observed (K shown beside). Node passes when all subskills pass + node check. Only engine changes node status.
**LTR**: retention needs actual delay ≥1 day since last relevant practice/help; review card per subskill at gate pass. Scheduler (**ask**): FSRS default params no fitting, or v3 baseline (2 days, doubling on success, reset on failure). Research favors fixed baseline (P3). Show "predicted (unmeasured)" until a delayed check. Scheduling needs consent; nothing unattended.
**Node check**: cumulative, assessment-partition only; ~60% this node / ~40% earlier nodes weighted to exam weight, coverage debt, open hypotheses; every original gap gets an independent recheck on a fresh item. Failing an earlier node's subskill ⇒ that node `needs_repair`, ≤5-min repair micro-loop inserted with notification.
**Feedback**: quoted flaws (quote, problem, suggestion, severity). blocking = wrong/missing idea, repair required; precision = imprecise/ambiguous, **deducts**, repair optional (short restatement offered); polish = noted, small/no deduction (ED). Advancement waits for feedback-display receipt (review-before-advance, on by default). Repair = restate correction / explain why wrong; graded cheaply; counts supported, never independent; the uncued fresh retry clears the gap. Dispute once per item; grader re-evaluates with learner argument; both logged; criterion-grounded disputes can change mark, praise can't. Leave with gaps: explicit + confirmation ⇒ `left_with_gaps`, unmet requirements kept and listed in session cheat sheet; grades unchanged.

## 9. Node loop (engine state machine)
Baseline (testable, not optimal): orient → diagnose → model/explain → guided attempt → independent retrieval/application → corrective feedback → new attempt → later review.
1. **Prime** (optional per mode): one generation attempt before instruction; not evidence (P2).
2. **Teach chunk**: one idea, ≤150 words or one worked example (ED). Worked example first when task new/complex and no independent evidence; fade only on component-level independent evidence (P1).
3. **Check**: can't be answered by copying the chunk (new context/representation, why, application, error, method choice). Chunk collapses during check.
4. **Grade**: deterministic where possible (MCQ, numeric, exact, ordering, matching); else grader. Strict, quoted, severity-tagged.
5. **Feedback → repair**: corrective, targeted rationale for conceptual goals (R06); repair required for blocking.
6. **Adapt**: engine emits ≤4 candidates + checkpoint (v3 priority: stop/constraints; prerequisite repair or discriminating hypothesis; less-supported fresh work after help; error-sensitive correction; varied application/selection; delayed retrieval; conditional advance). Tutor picks one + reasonCodes, then authors content. Success ⇒ fade, raise difficulty, or brief orientation + jump to different representation/context. Failure ⇒ diminishing cues → different representation (worked example/diagram) → fresh item from new family; never repeat an item; after repeated failure re-examine hypothesis/prerequisite. Selection target ⇒ mix confusables after basics, score selection separately.
7. **Gate**: re-evaluated after each graded attempt; all subskills pass ⇒ node check.
8. **Close**: summarizer writes node digest (≤120 tokens) + cheat sheet; engine offers a stopping point.
Diagnose while teaching: every graded attempt can add/support/contradict a hypothesis; flag gaps even on correct answers. Improvising: ad hoc items via same validator; inserting ≤5-min prerequisite/repair micro-node is automatic with notification; remove/merge/reorder needs learner approval.
**Item bank** at node start: ~10–15 items in one cheap call across subskills and difficulty 1–5 (5 = exam blueprint format/demand), partitioned teaching/practice/assessment, family IDs, documented variations, distractor rationales, anchored to `sampleSourceIds`. Drill source priority: learner instructions > selected exam/test questions > other questions > summaries.

## 10. Modes (presets over one loop; all values ED)
| | Cram (primary) | Learn | Drill | Accelerate |
|---|---|---|---|---|
| Time | budget (3–4 h) | horizon | per set | optional budget |
| Diagnostic | optional ≤6 items / ≤8 min, skippable; ≤3 targets per exam demand | optional | none (pick nodes) | strongly suggested ≤12 min, skippable |
| Teach w/o diagnostic | yes | yes | n/a | yes (no test-out) |
| Required dims | recall or execution (by subskill type) + one of explanation/selection + changed_application (near) | recall + explanation + selection (if relevant) + execution + changed_application; retention later | execution + selection at exam demand | as Cram, untested-out nodes only |
| K (normal / speed_up) | 2 / 1 | 3 / n/a | learner-controlled rounds | 2 / 1 |
| Teaching | ≤150 w, 1–2 representations | ≤120 w, more representations, slower fading | only after 2 failures (micro re-teach) | gaps only |
| Prime | on | on | off | off |
| Node check | 4–6 assessment items | 6–8 | continuous mixed rounds | 4 |
| End | mixed cumulative mini-set matched to exam format + session cheat sheet; short-horizon results labelled | same + review schedule (consent) | error-type report (conceptual/procedural/selection/slip/wording) | gap report |
Accelerate test-out: `tested_out` only when diagnostic evidence covers required dims with independent, changed-task items; one familiar success never enough; untested ⇒ unknown.
At start learner sets: mode (never asked again), preview profile, feature toggles, feedback rigor, review-before-advance, learning parameters (≤2000 chars), exam blueprint (optional; Sage infers, asks format/timing/samples), time budget — all compiled into the tutor's mode block.

## 11. Pacing and controls
Time on task per node; idle gaps >3 min excluded and logged as focus signal. Projected finish > budget by >10% (ED) ⇒ non-blocking **pace notice** after the current response, e.g. "2h10 of 3h · 5/9 nodes · projected ~3h40"; options Continue normal / Speed up / Extend time; plus Review plan (learner-only). Repeats ≤ once per node unless projection worsens. **Speed up** levers in order: K→1; skip Prime; denser chunks (one worked example then items); node checks → 3 items; precision repair optional. **Never skips nodes, subskills, or required dimensions.** Controls always available: Teach me (skip/end diagnostic), More practice, Advance (only if gate passes, else shows what's missing), Leave with gaps (confirm), Stop (checkpoint). Stop/cancel/blank never fabricates learner work.

## 12. Roles and token economy
| Role | Tier | When | Context |
|---|---|---|---|
| planner | strong | intake; consequential replan only | objective, mode, budget, blueprint, brain digest, source outline, diagnostic summary |
| tutor | strong/mid | teach + adapt turns | context packet |
| grader | cheap | open responses | item, rubric, key/reference, response, assistance level only |
| feynman | cheap | teach-backs | §7.4 + explanation grade |
| generator | cheap | node start bank, ad hoc | node card, subskills, misconceptions, blueprint, source spans |
| summarizer | cheap | node close, session end | node evidence summary, flaws, chunk list |
| validator | deterministic (+opt cheap) | before any item shown | item only |
Role calls: one-shot, no tools/extensions, ≤4,096 output tokens, 60 s deadline, cancelable. Objective items graded in code.
**Packet**: hard char cap (tutor ≤12,000, measure); ≤4 subskills, ≤3 hypotheses, ≤5 candidates; omissions explicit; pressure drops low-priority items. Layout: stable cacheable prefix `[short policy][mode block + preview + learner params][brain digest ≤1,800][plan outline]` | cache boundary | `[active node card][SessionState][evidence summary][≤6 messages of current item exchange][current task]`. ID drill-down (`learning_context`) within budget; never raw history or keys. Fresh pi session per node; closed nodes leave digests. Auto compaction off; manual governed path only. Log tokens/chars per role call. Targets: tutor in ≤5k avg, grader ≤1.2k, generator ≤3k in / ≤4k out.
**Tutor tools** (phase-scoped advertising): `context`, `select_move`, `present`, `propose`, `activity`. Grading/scoring/gating/scheduling/time aren't tools. Pi built-in coding tools off.
**Grader**: compact JSON `Grade`; quote evidence per criterion; list every flaw with severity (precision deducts); never round partial credit up; unseen ⇒ `not_observed`; no filler; feedback ≤60 words; calibration: ~85 response scores ≤~88. Score = 100 × mean criterion credit − deductions on met criteria; calibration targets must be values this formula can produce. A correct choice (binary or guessable: ser/estar, valid/invalid, yes/no, which method; or a correct fix with a wrong diagnosis) backed by a wrong or irrelevant reason earns 0.5 on the choice criterion; a wrong choice, or one the stem gives away, earns 0 (owner, 2026-11-08).
**Validator** (deterministic): stem lacks key/distinctive terms; MCQ 2–8 distinct choices, exactly one keyed, every distractor has rationale; stem non-empty/non-templated; check vs chunk lexical overlap < threshold; `evidences` + `partition` present; variation names baseline + changed dims, surface-only can't claim changed_application; numeric keys verified with `calculate` where grammar allows. Fail ⇒ regenerate once, then drop. Optional cheap "answerable & unambiguous?" toggle.
**Cost meter**: per call, per role; totals in `session.md` and API; unobservable states reported unknown.

## 13. Pi integration
One adapter (`packages/pi-adapter`), lint-enforced. Pin pi; check installed exported APIs before coding (v3: `@earendil-works/pi-coding-agent` 1.0.0, `createAgentSessionRuntime`, `createAgentSessionServices`, `createAgentSessionFromServices`, `InteractiveMode`). No TUI / no `InteractiveMode`. `UiBridge` covers everything extensions call on `ctx.ui` (verify set: select, confirm, input, editor, notify, status, custom widgets), forwarded over the API. Isolation: dedicated agent dir, `PI_CODING_AGENT_DIR` bound, no ambient `.pi` / `~/.agents/skills` unless opted in, no global credential copy, pi telemetry off; explicit import from `~/.pi/agent`. Existing pi extensions install via pi's package mechanism scoped to Sage; inventory owner's and ask which to bundle/recommend; reuse (web search, PDF extraction…). `package.json` `"sage"` field registers `activityTypes`, `graders`, `strategies`, `subjectAdapters`, `capabilities` (CapabilityRegistry + explicit permissions), `themes`, `exporters`, `sourceIngestors`; template in `templates/sage-extension/`, documented in `docs/EXTENSIONS.md`. `sage update`: install separately, check offline tutor startup, atomically select, roll back on failure; suppress pi's update notices; run `bun run eval:smoke` in the check. Extensions run with OS privileges; isolated home ≠ sandbox — say so wherever installed.

## 14. Files on disk
```
SAGE_HOME (~/.sage)
  brain.md settings.json agent/ data/sage.sqlite data/blobs/ data/usage.json
  sessions/<YYYY-MM-DD>-<topic-slug>/
    session.md plan.md
    nodes/<NN>-<slug>/ lesson.md items.md cheatsheet.md cheatsheet.pdf
    activities/ sources/ exports/
```
Markdown regenerated deterministically from ledger (no model calls); never overwrite user edits.

## 15. Exports
`session.md`: header (objective, mode, budget, blueprint, models); plan with statuses + STM per node by dimension; "Now" block (node, phase, nextIntendedMove, open hypotheses, coverage debt); condensed timeline (chunk → item → score → quoted flaws → gate changes → decisions → pace choices); stats (time per node, hints/assistance, accuracy by format & dimension, latency, idle gaps); cost. **Six outcomes shown separately, never pooled**: acquisition, explanation/understanding, recall, retention (delayed only), execution & selection, changed application — each with count, support level, delay. Node cheat sheet (summarizer, at node close, one page: definitions, formulas, procedures, distinctions, **"Your mistakes"** from quoted flaws/hypotheses). Session cheat sheet at end lists `left_with_gaps`. md→PDF: port v3 worker; check math/tables/code; if poor, **ask** about Typst.

## 16. Integrations (after core loop passes eval)
Sources: port v3 pipeline (content-addressed, line spans, needs_review → accept, excerpts untrusted, sharing consent, removal blocks future use) + PDF text extraction + past-exam import (`exam_sample`) + optional web-search source finding with per-result acceptance. Video: YouTube URL → subtitles → timestamp chunks → EmbeddingGemma via local Ollama (check exact tag) → vectors in SQLite (e.g. sqlite-vec; check Windows) + lexical; citations to timestamps. Obsidian: keep note import; `vaultPath` so sessions root can live in vault, frontmatter + `[[wikilinks]]`; never overwrite user notes. Usage: v3 counters. Capabilities: calculate, graph, drawing (Excalidraw) behind registry with honest unavailable states. Voice: define `ResponseInput { kind: "text"|"image"|"audio_transcript"; ... }` only.

## 17. Engine API (`docs/API.md`, Phase 2 contract)
WebSocket JSON-RPC, loopback, launch token. Model never authors learner responses, consent, approvals, source acceptance.
Methods: `session.create(goal, preview, blueprint)/list/resume/end`, `plan.get/edit/approve`, `diagnostic.skip`, `control.teach|morePractice|advance|leaveWithGaps(confirmToken)|stop`, `turn.send`, `item.submit(text|choice|fields|image[])`, `image.consent`, `transcription.confirm`, `hint.request(level)`, `chunk.peek`, `feedback.ack`, `grade.dispute`, `pace.set`, `time.extend`, `state.get`, `context.inspect` (dev), `export.get`, `sources.add/preview/accept/remove/list`, `settings.get/set`, `brain.get/set`, `usage.get/set`, `extensions.list/install/enable/disable/update/importFromPi`, `ui.respond`.
Events: `tutor.delta/done`, `item.present`, `activity.present`, `grade.result`, `feedback.present`, `repair.required`, `gate.update`, `node.status`, `pace.notice`, `plan.changed`, `hypothesis.changed`, `ui.request`, `cost.update`, `export.ready`, `error`. Version it; freeze v1 at end of Phase 1; ship JSON Schemas.

## 18. Eval (`packages/eval`)
Software checks don't establish learning efficacy — keep saying it. (1) Port applicable v3 tests. (2) Scripted personas (no model, CI): all-correct, all-wrong, copies-chunk, right-answer-wrong-reasoning, precise-idea-imprecise-wording, requests-every-hint. (3) Simulated learners (cheap model, local): fixed knowledge states, full Cram sessions on 2–3 units (integration methods, cellular respiration, a history argument). (4) Grader calibration ≥30 triples; owner grades ~10 anchors incl. precision cases; pass MAE ≤8 and no target ≤85 scores ≥95. (5) One assertion per F-row + plans not capped at 3; misconception persona can't pass without repair + uncued fresh success; Speed up never removes node/required dim; no supported attempt counts independent; budgets hold; every shown item passes validator. (6) Fixed-baseline comparison reported descriptively. (7) `bun run eval` → `eval/REPORT.md`; `bun run eval:smoke` fast CI subset.

## 19. Milestones (◆ = stop for owner questions)
M0 Orientation ◆ (V3_PORT, RESEARCH_MAP, DESIGN, first questions) · M1 Pure engine + ledger (storage, projection, assistance/family/variation/hypothesis rules, node loop, gates, candidates, pacing, scheduler, mode presets; scripted-persona eval with stubbed models) · M2 Agent layer ◆ (pi adapter + isolation, UiBridge, Sage extension + short policy, roles, packet + drill-down, item bank, validator, key verification, grader, Feynman; done when calibration passes + budgets reported) · M3 Server/API/dev console ◆ (`sage serve`, frozen API v1, real Cram e2e; done when simulated-learner eval passes + owner ran one session) · M4 Exports + session folders · M5 Activities ◆ · M6 Integrations.
If the day ends mid-way: stop at a clean boundary; update `PROGRESS.md` (milestone status, verified vs written, open questions + answers, next 3 tasks, commands).

## 20. Ask vs infer
Ask: departures from §2.1; every unsupported ED (one table); ~10 calibration anchors + precision/polish deduction points; scheduler; `/exam` fold vs fifth mode; default models per role; which pi extensions to bundle/recommend; DSL components beyond §7.6; pdf-lib vs Typst; every V3_PORT **ask**; any large/networked dependency; any research contradiction.
Infer: module boundaries, file names, tests, lint/format, error types, logs, dev console layout, small deps, behavior-preserving refactors, doc wording.

## 21. Definition of done (Phase 1)
Real Cram session on a full unit end-to-end via dev console: learner-approved plan; dimension+K gating; quoted severity-tagged grading; repair + dispute; pace notice + controls; cheat sheets md+PDF; readable `session.md` throughout. `bun run eval` passes every F-row; calibration passes; cost per Cram hour reported; fixed-baseline comparison runs. `docs/API.md` v1 frozen with JSON Schemas. Every pedagogical constant traces to RESEARCH_MAP or is an owner-approved ED. `PROGRESS.md` current.
