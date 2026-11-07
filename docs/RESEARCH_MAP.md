# Research map

Every pedagogical constant in `packages/engine/src/pedagogy.config.ts` points to a row ID here (`RM-xx`).

**Sources** (all under `outputs/`): **I** = `learning-science-final.md`; **S** = `synthesis/ideal-all-in-one-learning-system.md`; **E1–E3, P1–P3, D1–D4, U1–U3** = finding IDs in `synthesis/15-evidence-gaps.md`; **R02–R08** = `evidence/0N-*.md`.

**Tier** follows S15: Established (bounded) / Plausible / Disputed / Unknown / — (not a research claim).
**Status**: `SUPPORTED` (the mechanism has bounded behavioural support) · `PARTIAL` (supported only in a narrower scope than v4 uses it) · `ENGINEERING_DEFAULT` (no support for the value; owner approval needed) · `CONTRADICTED`.

None of the evidence validates the combined policy. I, "Policy conclusion": *start with a transparent fixed policy.* The fixed-baseline comparison in eval (§18.6) exists because of that.

## Mechanisms

| ID | Mechanism | v4 parameter | Value | Source | Tier | Status |
|---|---|---|---|---|---|---|
| RM-01 | Closed-book retrieval check after teaching | every chunk is followed by a check | always | I *Retrieval* row; E1; R02 | Established | SUPPORTED (delayed recall; weaker for transfer) |
| RM-02 | Corrective feedback after errors | feedback after every graded attempt | always | I *Feedback* row; R06 | Established | SUPPORTED |
| RM-03 | Targeted rationale for conceptual repair | feedback includes "why" when the goal is conceptual | on | I *Explanation* row; R06; S §3 row 2 | Plausible | PARTIAL (some domains) |
| RM-04 | Diminishing cues after a failed retrieval | cue levels after failure | 3 → 2 → 1 → uncued fresh item | E1 (Fiechter & Benjamin 2017) | Established, narrow | PARTIAL (adult word pairs, no-feedback condition) |
| RM-05 | Uncued fresh retry is what clears a gap | only uncued + new-family success counts as independent | rule | S §3 row 2 ("corrected reasoning on an independent item"); I *Keep the goals separate* | Plausible | SUPPORTED as a measurement rule |
| RM-06 | Worked example first for new complex tasks | example-first when no independent evidence | rule | P1; I *Worked example* row; R04 | Plausible | PARTIAL |
| RM-07 | Fade on component-level independent evidence, not a timer | fade trigger | 1 independent success on that subskill | P1; I *Worked example* row | Plausible | ENGINEERING_DEFAULT (trigger value) |
| RM-08 | Productive failure = attempt then instruction | Prime step | see ED-12 | P2; R04 | Plausible | PARTIAL (procedural, 1-week, 6th-grade algebra) |
| RM-09 | Mix only after basics, only when selection is a target; score selection separately | interleaving gate; `selection` is its own dimension | rule | D2; I *Mixed practice* row; S §3 row 5 | Disputed | PARTIAL |
| RM-10 | Transfer must state what changed | variation contract (baseline + changedDimensions + invariant); surface-only can't claim changed_application | rule | D4; S §1 "Transfer dimensions"; R08 | Disputed | SUPPORTED as a measurement rule |
| RM-11 | Hold back assessment items | `assessment` partition, used only in node checks | rule | S §1 | — (design synthesis) | PARTIAL |
| RM-12 | Keep outcomes separate, never pooled | 7 dimensions; 6 outcomes reported separately | rule | I *Keep the goals separate*; S §5 | Established (measurement) | SUPPORTED |
| RM-13 | Practice accuracy ≠ learning; report short horizon separately | Cram end report labels short-horizon results | rule | E3; I *Rapid preparation* row | Established, narrow | SUPPORTED |
| RM-14 | Spacing helps delayed recall; start with a fixed baseline | scheduler | see Q1 | E2; P3; I *Spacing* row | Established (direction) / Plausible (adaptive) | SUPPORTED (direction); interval is ED |
| RM-15 | Retention needs an actual delay | min delay for retention credit | 1 day | I *Keep the goals separate* ("prespecified interval"); v3 | — | ENGINEERING_DEFAULT |
| RM-16 | Repeated failure ⇒ different explanation/representation, not repetition | never repeat an item; after N fails re-examine hypothesis | N = 2 | S §4 | Plausible | PARTIAL (N is ED) |
| RM-17 | Confidence/fluency mislead; learner may override | no confidence-based gating; learner controls | rule | R07; S §3 row 6 | Plausible | SUPPORTED |
| RM-18 | Explanation ≠ procedural accuracy; MCQ alone ≠ understanding | MCQ evidences explanation only with a "why" | rule | I *Keep the goals separate* | Established (measurement) | SUPPORTED |
| RM-19 | Self-explanation/teach-back is conditional | Feynman is an opt-in move, not every node | rule | D3; I *Explanation, examples* | Disputed | PARTIAL |
| RM-20 | Case comparison + named invariant for abstraction | library: contrasting cases | opt-in | D4; R08; I *Transfer* row | Disputed | PARTIAL → `LIBRARY_CANDIDATES.md` |
| RM-21 | Fixed transparent comparison policy | eval baseline | same content/time/feedback | I *Simple baseline*; S §6 | — | SUPPORTED (as evaluation design) |
| RM-22 | No universal mastery threshold | gate is dimensions + K, not a score | rule | S §4 bold; U1 | Unknown | SUPPORTED (as a constraint) |
| RM-23 | Feedback timing has no winner | feedback immediately after each graded attempt (corrects before errors propagate) | immediate | D1; I *Feedback* row ("correct errors promptly when they could propagate") | Disputed | PARTIAL |
| RM-24 | Rapid prep = test-matched practice | level-5 items match the blueprint format; Cram end mini-set matches exam format | rule | I *Rapid preparation* row; S §3 last row | Unknown | PARTIAL (no recipe established) |

Nothing in the corpus contradicts a spec mechanism outright. The two tensions are in the parameter values (ED-12, ED-05/06 below).

## Engineering defaults (owner-approved 2026-11-07)

None of these numbers has support in the corpus (S §4: *"No exact success threshold, spacing formula, guidance-fading trigger, or combined policy is established"*). The value is the spec's, unless marked **changed**.

| ID | Parameter | Proposed | Note |
|---|---|---|---|
| ED-01 | Pass mark for a dimension observation | 80 / 100 | |
| ED-02 | K independent checks per subskill: Cram / Learn / Accelerate | 2 / 3 / 2 | Learn's 3 matches v3's gate |
| ED-03 | K under Speed up | 1 | |
| ED-04 | Min distinct exposure families per subskill | 2 | |
| ED-05 | **Tension:** with K=1 (Speed up), "K checks across ≥2 families" can't be satisfied | **changed:** families ≥ min(K, 2) | With K=1 the gate is still several observations, because required dimensions are claimed on different items. Ask. |
| ED-06 | Required dimensions per mode | SPEC §10 table | |
| ED-07 | Chunk word cap: Cram / Learn | 150 / 120 | |
| ED-08 | Lexical-overlap cap, check vs chunk | ≤ 0.35 of the check's content-word 4-grams appear in the chunk | **new value**; spec gives no number |
| ED-09 | Diagnostic cap: Cram / Accelerate | ≤6 items or ≤8 min / ≤12 min | |
| ED-10 | Node check size: Cram / Learn / Accelerate / Speed up | 4–6 / 6–8 / 4 / 3 | |
| ED-11 | Node check split this node / earlier | 60 / 40 | |
| ED-12 | **Tension:** Prime "on" for Cram & Learn, but P2's benefit was procedural only, and Cram is time-boxed | **changed:** Prime only for procedural subskills (execution-type) in Cram/Learn; off otherwise | Research-aligned narrowing. Ask. |
| ED-13 | Repair micro-loop cap | 5 min | |
| ED-14 | Pace-notice threshold | projected > budget × 1.10 | |
| ED-15 | Idle gap excluded from time on task | > 3 min | |
| ED-16 | Pace notice frequency | ≤1 per node unless projection worsens | |
| ED-17 | Struggle signal (may *offer* a hint) | 2 failed attempts on the subskill, or latency > 3× the node median (min 90 s) | **new value** for latency |
| ED-18 | Item bank size at node start | 12 (range 10–15) | |
| ED-19 | Retention min delay | 1 day | v3 |
| ED-20 | Review interval (if v3 baseline wins Q1) | 2 days, ×2 on delayed success, reset on failure, capped by horizon | v3 |
| ED-21 | Open + high-confidence hypothesis blocks the gate | yes | |
| ED-22 | Node digest | ≤120 tokens | |
| ED-23 | Tutor packet cap | 12,000 chars | v3 was 16,000 |
| ED-24 | Grader feedback cap | 60 words | |
| ED-25 | Precision / polish deductions | −5 / −1 per flaw | owner, M2 batch |
| ED-26 | Repeated-failure escalation N | 2 | RM-16 |
| ED-27 | Max cue levels in a diminishing-cue sequence | 3 | RM-04 |

## Not in the corpus

Sleep, stress, fatigue, circadian timing (U2), and age/culture transportability (U3) are unassessed. v4 doesn't model them. Session-length advice for a 3–4 h Cram has no source; the pace notice is engineering, not pedagogy.
