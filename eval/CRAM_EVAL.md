# Cram eval (M3): 2026-11-07T22:43:28.907Z

Roles: planner gemini-3.8-flash, tutor gemini-3.8-flash, grader gemini-3.8-flash, generator gemini-3.8-flash, feynman gemini-3.8-flash, summarizer gemini-3.8-flash, researcher gemini-3.8-flash, checker gemini-3.8-flash. Simulated learner: gemini-3.8-flash with a fixed knowledge profile per unit. Baseline = same real roles, deterministic non-adaptive tutor (first candidate, first unused item, one-line chunks).
Clock is virtual (learner think and read time only); model latency is in the wall column. Learners never use hints, so assisted paths are not exercised here.

| unit | domain | arm | budget min | plan estimate min | nodes passed in budget | minutes to pass each node | end-of-session mixed check | cost per session-hour | model calls | progress | wall | end state |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| calc | math | adaptive | 90 | 138 (over) | 1/5 | 26, —, —, —, — | not reached | $0.18 | 81 | 31 graded (19 independent), mean 71, 45 min used, reached 2 nodes | 1423 s | adapt; 1 errors: tutor_failed |
