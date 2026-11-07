# Cram eval (M3): 2026-11-07T19:29:05.177Z

Roles: planner gpt-6.1-sol, tutor gpt-6.1-sol, grader gpt-6.1-sol, generator gemini-3.8-flash, feynman gemini-3.8-flash, summarizer gemini-3.8-flash, researcher gemini-3.8-flash. Simulated learner: gemini-3.8-flash with a fixed knowledge profile per unit. Baseline = same real roles, deterministic non-adaptive tutor (first candidate, first unused item, one-line chunks).
Clock is virtual (learner think and read time only); model latency is in the wall column. Learners never use hints, so assisted paths are not exercised here.

| unit | domain | arm | nodes passed in budget | minutes to pass each node | end-of-session mixed check | cost per session-hour | model calls | wall | end state |
|---|---|---|---|---|---|---|---|---|---|
| aid | first aid (non-academic) | adaptive | 0/6 | —, —, —, —, —, — | not reached | $0.66 | 51 | 539 s | grading; 4 errors: role_failed, learner_action_rejected |
| aid | first aid (non-academic) | baseline | 0/6 | —, —, —, —, —, — | not reached | $0.06 | 56 | 213 s | check |
| calc | math | adaptive | 0/4 | —, —, —, — | not reached | $0.65 | 99 | 890 s | feedback; 1 errors: role_failed |
| calc | math | baseline | 0/4 | —, —, —, — | not reached | $0.02 | 51 | 134 s | feedback; 1 errors: role_failed |
| esp | language | adaptive | 0/5 | —, —, —, —, — | not reached | $0.56 | 54 | 464 s | grading; 4 errors: role_failed, learner_action_rejected |
| esp | language | baseline | 0/5 | —, —, —, —, — | not reached | $0.04 | 54 | 161 s | feedback; 1 errors: role_failed |
| resp | biology | adaptive | 0/5 | —, —, —, —, — | not reached | $0.61 | 82 | 942 s | feedback; 1 errors: role_failed |
| resp | biology | baseline | 0/5 | —, —, —, —, — | not reached | $0.06 | 57 | 196 s | feedback; 1 errors: role_failed |
| ww1 | history | adaptive | 0/5 | —, —, —, —, — | not reached | $0.70 | 43 | 491 s | grading; 4 errors: role_failed, learner_action_rejected |
| ww1 | history | baseline | 0/5 | —, —, —, —, — | not reached | $0.03 | 55 | 143 s | feedback; 1 errors: role_failed |
