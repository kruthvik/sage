# Eval report

Generated 2026-11-07T17:28:15.168Z by `bun run eval`. Offline scripted personas on a 2-node fixture unit (calculus) with stub models.
**These are software checks. They don't establish that Sage improves learning.** The fixture subject is a test case, not the product's scope.

## Primary: single-session Cram efficiency

| Persona | Nodes passed within budget | Time to pass each node | End-of-session mixed check | Cost per session-hour |
|---|---|---|---|---|
| all-correct | 2/2 in 60 min | n1 8m, n2 8m | no items left | unknown (stub models) |
| all-wrong | 0/2 in 60 min | – | no items left | unknown (stub models) |
| copies-chunk | 0/2 in 60 min | – | no items left | unknown (stub models) |
| right-answer-wrong-reasoning | 0/2 in 60 min | – | no items left | unknown (stub models) |
| imprecise-wording | 2/2 in 60 min | n1 8m, n2 8m | no items left | unknown (stub models) |
| requests-every-hint | 0/2 in 60 min | – | no items left | unknown (stub models) |

## Secondary

| Persona | Attempts | Independent | Mean score | Reducer errors |
|---|---|---|---|---|
| all-correct | 14 | 12 | 99 | 0 |
| all-wrong | 169 | 40 | 6 | 0 |
| copies-chunk | 169 | 40 | 6 | 0 |
| right-answer-wrong-reasoning | 150 | 135 | 96 | 0 |
| imprecise-wording | 14 | 12 | 97 | 0 |
| requests-every-hint | 119 | 0 | 100 | 0 |

Pending: simulated learners on ≥5 domains (≥1 non-academic), grader calibration (10 owner anchors + ≥20 triples over ≥6 domains), fixed-baseline comparison, per-turn token budgets.
F-row assertions live in `packages/eval/test` and `packages/engine/test`; run `bun test`.
