# Cram eval (M3): 2026-11-07T20:24:52.484Z

Roles: planner gpt-6.1-sol, tutor gpt-6.1-sol, grader gpt-6.1-sol, generator gemini-3.8-flash, feynman gemini-3.8-flash, summarizer gemini-3.8-flash, researcher gemini-3.8-flash. Simulated learner: gemini-3.8-flash with a fixed knowledge profile per unit. Baseline = same real roles, deterministic non-adaptive tutor (first candidate, first unused item, one-line chunks).
Clock is virtual (learner think and read time only); model latency is in the wall column. Learners never use hints, so assisted paths are not exercised here.

| unit | domain | arm | nodes passed in budget | minutes to pass each node | end-of-session mixed check | cost per session-hour | model calls | progress | wall | end state |
|---|---|---|---|---|---|---|---|---|---|---|
| calc | math | adaptive | 0/4 | —, —, —, — | not reached | $0.38 | 62 | 34 graded (30 independent), mean 68, 48 min used, reached 1 nodes | 565 s | feedback; 1 errors: role_failed |
