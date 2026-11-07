# Cram eval (M3): 2026-11-07T20:12:25.612Z

Roles: planner gpt-6.1-sol, tutor gpt-6.1-sol, grader gpt-6.1-sol, generator gemini-3.8-flash, feynman gemini-3.8-flash, summarizer gemini-3.8-flash, researcher gemini-3.8-flash. Simulated learner: gemini-3.8-flash with a fixed knowledge profile per unit. Baseline = same real roles, deterministic non-adaptive tutor (first candidate, first unused item, one-line chunks).
Clock is virtual (learner think and read time only); model latency is in the wall column. Learners never use hints, so assisted paths are not exercised here.

| unit | domain | arm | nodes passed in budget | minutes to pass each node | end-of-session mixed check | cost per session-hour | model calls | progress | wall | end state |
|---|---|---|---|---|---|---|---|---|---|---|
| aid | first aid (non-academic) | adaptive | 0/5 | —, —, —, —, — | not reached | $0.66 | 81 | 22 graded (18 independent), mean 80, 49 min used, reached 1 nodes | 981 s | feedback; 1 errors: role_failed |
| aid | first aid (non-academic) | baseline | 0/6 | —, —, —, —, —, — | not reached | $0.06 | 55 | 32 graded (9 independent), mean 62, 49 min used, reached 1 nodes | 195 s | feedback; 1 errors: role_failed |
| calc | math | adaptive | 0/4 | —, —, —, — | not reached | $0.78 | 98 | 33 graded (32 independent), mean 94, 48 min used, reached 1 nodes | 1098 s | feedback; 1 errors: role_failed |
| calc | math | baseline | 0/4 | —, —, —, — | not reached | $0.02 | 49 | 33 graded (10 independent), mean 42, 48 min used, reached 1 nodes | 143 s | feedback; 1 errors: role_failed |
| esp | language | adaptive | 0/4 | —, —, —, — | not reached | $0.71 | 93 | 29 graded (27 independent), mean 87, 48 min used, reached 1 nodes | 1023 s | check; 1 errors: role_failed |
| esp | language | baseline | 0/5 | —, —, —, —, — | not reached | $0.03 | 52 | 34 graded (12 independent), mean 53, 49 min used, reached 1 nodes | 170 s | feedback; 1 errors: role_failed |
| resp | biology | adaptive | 0/5 | —, —, —, —, — | not reached | $0.68 | 83 | 23 graded (22 independent), mean 76, 48 min used, reached 1 nodes | 1033 s | feedback; 1 errors: role_failed |
| resp | biology | baseline | 0/5 | —, —, —, —, — | not reached | $0.05 | 56 | 32 graded (11 independent), mean 56, 48 min used, reached 1 nodes | 169 s | feedback; 1 errors: role_failed |
| ww1 | history | adaptive | 0/5 | —, —, —, —, — | not reached | $0.69 | 76 | 19 graded (19 independent), mean 84, 49 min used, reached 1 nodes | 1147 s | feedback; 1 errors: role_failed |
| ww1 | history | baseline | 0/5 | —, —, —, —, — | not reached | $0.16 | 49 | 6 graded (3 independent), mean 67, 49 min used, reached 1 nodes | 427 s | feedback; 1 errors: role_failed |
