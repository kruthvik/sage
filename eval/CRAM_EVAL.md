# Cram eval (M3, all roles on gemini-3.8-flash): 2026-11-07

Roles: planner, tutor, grader, generator, feynman, summarizer, researcher and checker all on antigravity/gemini-3.8-flash (owner: Sol quota out; flash must work). Simulated learner: gemini-3.8-flash with a fixed knowledge profile per unit. Baseline = same real roles, deterministic non-adaptive tutor (first candidate, first unused item, one-line chunks).
Clock is virtual (learner think and read time only); model latency is in the wall column. Learners never use hints, so assisted paths are not exercised. Budgets 90–120 min (owner). Plan estimate = gate-based estimate (ED-29) at plan approval.

Sources: adaptive rows from the main run; the calc adaptive row is the rerun after the grader-retry fix (the main-run calc stalled at 26 min on rejected grades: 1/4, 19 min). Baseline rows are reruns after the baseline-tutor stall fix (main-run baselines stopped after 0–10 grades).

| unit | domain | arm | budget min | plan estimate min | nodes passed in budget | minutes to pass each node | end-of-session mixed check | cost per session-hour | model calls | progress | wall | end state |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| aid | first aid (non-academic) | adaptive | 120 | 174 (over) | 1/5 | 59, —, —, —, — | not reached | $0.10 | 155 | 63 graded (54 independent), mean 92, 103 min used, reached 2 nodes | 2472 s | repair; 3 errors: learner_action_rejected |
| aid | first aid (non-academic) | baseline | 120 | 138 (over) | 0/5 | —, —, —, —, — | not reached | $0.01 | 185 | 126 graded (35 independent), mean 52, 193 min used, reached 1 nodes | 449 s | check |
| calc | math | adaptive | 90 | 108 (over) | 2/4 | 21, 36, —, — | not reached | $0.17 | 94 | 37 graded (29 independent), mean 86, 53 min used, reached 3 nodes | 1728 s | grading; 4 errors: tutor_failed, role_failed |
| calc | math | baseline | 90 | 116 (over) | 0/4 | —, —, —, — | not reached | $0.01 | 136 | 95 graded (26 independent), mean 53, 144 min used, reached 1 nodes | 330 s | check |
| esp | language | adaptive | 90 | 112 (over) | 1/4 | 66, 114, —, — | not reached | $0.07 | 188 | 110 graded (92 independent), mean 79, 144 min used, reached 3 nodes | 2503 s | node_check; 1 errors: role_failed |
| esp | language | baseline | 90 | 108 (over) | 0/4 | —, —, —, — | not reached | $0.01 | 139 | 95 graded (25 independent), mean 57, 144 min used, reached 1 nodes | 417 s | feedback |
| resp | biology | adaptive | 90 | 130 (over) | 2/5 | 63, 82, 116, —, — | not reached | $0.12 | 222 | 94 graded (73 independent), mean 88, 144 min used, reached 4 nodes | 3416 s | feedback; 4 errors: tutor_failed, role_failed |
| resp | biology | baseline | 90 | 118 (over) | 0/4 | —, —, —, — | not reached | $0.01 | 145 | 94 graded (26 independent), mean 49, 145 min used, reached 1 nodes | 346 s | feedback |
| ww1 | history | adaptive | 120 | 104 | 0/4 | —, —, —, — | not reached | $0.04 | 220 | 32 graded (30 independent), mean 63, 192 min used, reached 1 nodes | 2194 s | check |
| ww1 | history | baseline | 120 | 130 (over) | 0/5 | —, —, —, —, — | not reached | $0.01 | 183 | 121 graded (32 independent), mean 39, 192 min used, reached 1 nodes | 529 s | feedback |

## Reading it

- Adaptive beats baseline on every unit that passed anything: 7 nodes passed in budget across the 5 units (aid 1, calc 2, esp 1, resp 2, ww1 0) vs 0 for the baseline. Baseline answers more items but few count as independent evidence, and its mean stays 39–57.
- No unit reached the end-of-session mixed check. Gate-based plan estimates were over budget in 4 of 5 units (ww1 fit), so in a real session the learner would see extend / merge / Speed-up at approval; the eval doesn't pick one.
- ww1 (history, long-form answers) passed nothing in 192 min: flash grades its written answers low (mean 63) and the gate needs changed-application evidence it rarely awards.
- Remaining flash failures: grader replies with no parseable JSON (3× in the calc rerun; LaTeX escapes are now repaired, other causes not yet seen), occasional tutor_failed, and network errors (ENOTFOUND daily-cloudcode-pa.googleapis.com) in aid. Failed grades park the session in "grading" until retried.
- Cost: $0.04–0.17 per session-hour adaptive, about $0.01 baseline.

## Rerun after flash grading changes (2026-11-08, all flash, adaptive only)

Grader answers through the forced `submit_grade` tool; per-criterion decision order in the prompt. Hypothesis fix below was not in this run.

| unit | domain | arm | budget min | plan estimate min | nodes passed in budget | minutes to pass each node | end-of-session mixed check | cost per session-hour | model calls | progress | wall | end state |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| calc | math | adaptive | 90 | 116 (over) | 3/4 | 15, 35, 50, — | not reached | $0.18 | 289 | 92 graded (60 independent), mean 92, 144 min used, reached 4 nodes | 4811 s | feedback; 1 errors: tutor_failed |
| ww1 | history | adaptive | 120 | 122 (over) | 0/5 | —, —, —, —, — | not reached | $0.24 | 421 | 209 graded (184 independent), mean 83, 192 min used, reached 1 nodes | 9518 s | feedback; 2 errors: tutor_failed |

- calc: 3/4 in budget (was 1/4, then 2/4); 0 grader errors in 92 grades (earlier runs stalled on unparseable grades).
- ww1: 0/5 again, but not a grading problem: the flash tutor proposed 4 hypotheses on node 1's first subskill (two high-confidence, which block the gate) and never resolved them, then chose `probe_hypothesis` 123 times. Only the first (medium) hypothesis was ever offered as a probe target. Fixed in the engine afterwards: graded probes now resolve a hypothesis in code (2 independent passes) or mark it uncertain after 3 probes, and high-confidence hypotheses are probed first.

ww1 rerun with the hypothesis fix (d90cd18):

| unit | domain | arm | budget min | plan estimate min | nodes passed in budget | minutes to pass each node | end-of-session mixed check | cost per session-hour | model calls | progress | wall | end state |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ww1 | history | adaptive | 120 | 104 | 1/4 | 60, 127, —, — | not reached | $0.09 | 284 | 82 graded (54 independent), mean 76, 192 min used, reached 3 nodes | 3743 s | check |

- 1/4 in budget (was 0/5); the second node passed at 127 min, just over. The planner made 4 nodes this time (5 before), so plans differ run to run.
- The tutor proposed no hypotheses in this run, so the probe fix wasn't exercised live; it is covered by engine tests only.

## Terra defaults (2026-11-08: planner, tutor, grader on openai/gpt-6.1-terra; generator, checker, summarizer, researcher and simulated learner on flash; adaptive only)

| unit | domain | arm | budget min | plan estimate min | nodes passed in budget | minutes to pass each node | end-of-session mixed check | cost per session-hour | model calls | progress | wall | end state |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| calc | math | adaptive | 90 | 192 (over) | 3/6 | 18, 40, 73, 98, —, — | not reached | $0.26 | 242 | 96 graded (79 independent), mean 85, 145 min used, reached 5 nodes | 1765 s | feedback |
| calc | math | adaptive | 90 | 173 (over) | 3/5 | 32, 51, 88, 126, — | not reached | $0.27 | 249 | 96 graded (78 independent), mean 83, 143 min used, reached 5 nodes | 1925 s | check; 4 errors: tutor_fallback, tutor_failed |
| calc | math | adaptive | 90 | 89 | 3/3 | 22, 41, 88 | not reached | $0.24 | 141 | 56 graded (40 independent), mean 69, 88 min used, reached 3 nodes | 1064 s | ended |

- Run 3 (third row) adds the planner budget hint and the per-phase tutor cache key. The plan fit the budget (3 nodes, 89-min estimate), every node passed inside 90 min, and it took 141 calls instead of about 245. Cost per session-hour fell only from $0.27 to $0.24, so caching still isn't visibly paying off.
- Runs 1–2 used the old planner (no budget hint), so plans were 5–6 nodes against a 90-min budget; see eval/PLANNER_FIT.md for the fix.
- Cost by role, run 1: tutor $0.46 of $0.62 (74%), grader $0.12. Run 2 (with the prompt-cache keys): tutor $0.49, grader $0.12, i.e. no caching discount showed up in the eval although a direct probe (no reasoning setting) cached 1,152 of 1,253 grader tokens. Not yet explained; the reasoning-low path could not be probed because the owner's usage limit was reached.
- Run 2's 3 tutor_failed errors near the end are probably that usage limit ("Subscription Sharing usage limit").
