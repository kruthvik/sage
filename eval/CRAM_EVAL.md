# Cram eval (M3): 2026-11-07T20:48:07.642Z

Roles: planner gpt-6.1-sol, tutor gpt-6.1-sol, grader gpt-6.1-sol, generator gemini-3.8-flash, feynman gemini-3.8-flash, summarizer gemini-3.8-flash, researcher gemini-3.8-flash. Simulated learner: gemini-3.8-flash with a fixed knowledge profile per unit. Baseline = same real roles, deterministic non-adaptive tutor (first candidate, first unused item, one-line chunks).
Clock is virtual (learner think and read time only); model latency is in the wall column. Learners never use hints, so assisted paths are not exercised here.

| unit | domain | arm | nodes passed in budget | minutes to pass each node | end-of-session mixed check | cost per session-hour | model calls | progress | wall | end state |
|---|---|---|---|---|---|---|---|---|---|---|
| aid | first aid (non-academic) | adaptive | 0/6 | —, —, —, —, —, — | not reached | $0.54 | 58 | 16 graded (13 independent), mean 85, 31 min used, reached 1 nodes | 421 s | grading; 7 errors: tutor_fallback, role_failed, learner_action_rejected |
| aid | first aid (non-academic) | baseline | 0/6 | —, —, —, —, —, — | not reached | $0.25 | 28 | 6 graded (1 independent), mean 85, 13 min used, reached 1 nodes | 138 s | check; 3 errors: tutor_failed |
| calc | math | adaptive | 0/4 | 32, —, —, — | not reached | $0.43 | 71 | 35 graded (28 independent), mean 91, 48 min used, reached 2 nodes | 622 s | check; 1 errors: role_failed |
| calc | math | baseline | 0/4 | —, —, —, — | not reached | $0.02 | 51 | 32 graded (9 independent), mean 59, 48 min used, reached 1 nodes | 149 s | feedback; 1 errors: role_failed |
| esp | language | adaptive | 0/4 | —, —, —, — | not reached | $0.34 | 55 | 31 graded (24 independent), mean 62, 43 min used, reached 1 nodes | 525 s | grading; 7 errors: tutor_fallback, role_failed, learner_action_rejected |
| esp | language | baseline | 0/5 | —, —, —, —, — | not reached | $0.04 | 53 | 32 graded (7 independent), mean 34, 49 min used, reached 1 nodes | 161 s | feedback |
| resp | biology | adaptive | 0/5 | —, —, —, —, — | not reached | $0.56 | 82 | 20 graded (15 independent), mean 69, 49 min used, reached 1 nodes | 682 s | check; 1 errors: role_failed |
| resp | biology | baseline | 0/5 | —, —, —, —, — | not reached | $0.21 | 25 | 6 graded (2 independent), mean 75, 9 min used, reached 1 nodes | 90 s | check; 4 errors: tutor_failed, role_failed |
| ww1 | history | adaptive | 0/4 | —, —, —, — | not reached | $0.20 | 46 | 2 graded (1 independent), mean 94, 49 min used, reached 1 nodes | 449 s | feedback; 1 errors: role_failed |
| ww1 | history | baseline | 0/5 | —, —, —, —, — | not reached | $0.04 | 54 | 32 graded (9 independent), mean 39, 49 min used, reached 1 nodes | 149 s | feedback |
