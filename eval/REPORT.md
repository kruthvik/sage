# Eval report

Generated 2026-11-07T16:57:07.430Z by `bun run eval`. Offline scripted personas on a 2-node fixture unit with stub models.
**These are software checks. They don't establish that Sage improves learning.**

| Persona | Nodes passed | Attempts | Independent | Mean score | Reducer errors |
|---|---|---|---|---|---|
| all-correct | 2/2 | 14 | 12 | 99 | 0 |
| all-wrong | 0/2 | 169 | 40 | 6 | 0 |
| copies-chunk | 0/2 | 169 | 40 | 6 | 0 |
| right-answer-wrong-reasoning | 0/2 | 150 | 135 | 96 | 0 |
| imprecise-wording | 2/2 | 14 | 12 | 97 | 0 |
| requests-every-hint | 0/2 | 119 | 0 | 100 | 0 |

Pending: simulated learners (cheap model), grader calibration (≥30 triples, owner anchors), fixed-baseline comparison, per-turn token budgets.
F-row assertions live in `packages/eval/test` and `packages/engine/test`; run `bun test`.
