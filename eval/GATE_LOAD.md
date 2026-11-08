# Gate load vs the plan-fit estimate (R&D from eval ledgers, 2026-11-08, no model calls)

The plan-fit estimate (ED-29, `gateMinutes`) assumes each subskill needs its minimum items × RETRY_FACTOR 1.2, plus the node check. This counts the attempts passed nodes actually took in the saved Cram eval ledgers (`bun packages/eval/experiments/gate-load.ts <ledgers>`). Ledgers recorded by older engine versions that no longer replay are skipped.

| ledger | node | subskills | estimate's attempts (incl. retries + node check) | actual attempts | actual / estimate | scored < 80 | not independent |
|---|---|---|---|---|---|---|---|
| sage-eval-aid-iAgOdl | n1 | 3 | 18 | 46 | 2.53 | 4 | 7 |
| sage-eval-calc-7Kqi7t | n1 | 2 | 15 | 14 | 0.96 | 4 | 1 |
| sage-eval-calc-FOzeXn | n1 | 3 | 17 | 23 | 1.35 | 5 | 7 |
| sage-eval-calc-FOzeXn | n2 | 2 | 15 | 14 | 0.96 | 3 | 5 |
| sage-eval-calc-FOzeXn | n3 | 3 | 19 | 25 | 1.29 | 3 | 2 |
| sage-eval-calc-FOzeXn | n4 | 3 | 19 | 30 | 1.55 | 8 | 8 |
| sage-eval-calc-uTb1O9 | n1 | 2 | 13 | 13 | 0.97 | 1 | 4 |
| sage-eval-calc-uTb1O9 | n2 | 2 | 13 | 16 | 1.19 | 1 | 3 |
| sage-eval-calc-uTb1O9 | n3 | 2 | 15 | 23 | 1.58 | 4 | 4 |
| sage-eval-calc-uTb1O9 | n4 | 3 | 19 | 16 | 0.82 | 2 | 3 |
| sage-eval-esp-pOOc9i | n1 | 2 | 13 | 54 | 4.03 | 11 | 9 |
| sage-eval-esp-pOOc9i | n2 | 2 | 13 | 38 | 2.84 | 7 | 10 |
| sage-eval-resp-lbFfRH | n1 | 2 | 12 | 49 | 4.02 | 8 | 11 |
| sage-eval-resp-lbFfRH | n2 | 2 | 13 | 14 | 1.04 | 0 | 6 |
| sage-eval-resp-lbFfRH | n3 | 2 | 15 | 26 | 1.78 | 4 | 5 |
| sage-eval-ww1-zTrA5y | n1 | 2 | 13 | 45 | 3.36 | 20 | 25 |
| sage-eval-ww1-zTrA5y | n2 | 2 | 12 | 48 | 3.93 | 11 | 27 |

Overall actual / estimate: 1.93 over 17 passed nodes.

## Attempts that couldn't advance the gate (`gate-waste.ts`)

| ledger | graded attempts | useful (item could evidence a missing dimension) | wasted | top wasted activity × evidences | what was missing then (top) |
|---|---|---|---|---|---|
| sage-eval-aid-ViGGKl | 126 | 118 | 8 (6%) | 8× free_recall [recall] | 16× dimension; 3× latest_attempt_failed |
| sage-eval-aid-bkLazX | 126 | 126 | 0 (0%) |  |  |
| sage-eval-aid-iAgOdl | 34 | 31 | 3 (9%) | 2× conceptual_mcq [selection]; 1× apply_problem [execution] | 3× latest_attempt_failed |
| sage-eval-calc-6PhWGE | 3 | 3 | 0 (0%) |  |  |
| sage-eval-calc-7Kqi7t | 11 | 10 | 1 (9%) | 1× apply_problem [execution] | 1× latest_attempt_failed |
| sage-eval-calc-FOzeXn | 69 | 56 | 13 (19%) | 5× apply_problem [changed_application]; 3× apply_problem [execution] | 17× dimension; 3× latest_attempt_failed |
| sage-eval-calc-XVnm7S | 95 | 4 | 91 (96%) | 91× free_recall [recall] | 91× dimension; 45× latest_attempt_failed |
| sage-eval-calc-fqW5fk | 0 | 0 | 0 (0%) |  |  |
| sage-eval-calc-uTb1O9 | 66 | 54 | 12 (18%) | 5× find_the_error [explanation]; 4× apply_problem [execution] | 6× dimension; 6× latest_attempt_failed |
| sage-eval-calc-x3nbOO | 3 | 3 | 0 (0%) |  |  |
| sage-eval-esp-16kQoy | 0 | 0 | 0 (0%) |  |  |
| sage-eval-esp-pOOc9i | 40 | 34 | 6 (15%) | 4× conceptual_mcq [selection]; 1× explain_why [explanation] | 5× latest_attempt_failed; 1× dimension |
| sage-eval-esp-tMK0Z1 | 95 | 95 | 0 (0%) |  |  |
| sage-eval-resp-MeOTLG | 94 | 5 | 89 (95%) | 89× free_recall [recall] | 89× dimension; 47× latest_attempt_failed |
| sage-eval-resp-eM9MP7 | 4 | 4 | 0 (0%) |  |  |
| sage-eval-resp-lbFfRH | 49 | 42 | 7 (14%) | 2× conceptual_mcq [selection]; 2× explain_why [explanation] | 4× latest_attempt_failed; 2× (nothing: already passed) |
| sage-eval-ww1-5hvsEM | 10 | 10 | 0 (0%) |  |  |
| sage-eval-ww1-Jlo4Fm | 32 | 32 | 0 (0%) |  |  |
| sage-eval-ww1-KSquxb | 121 | 121 | 0 (0%) |  |  |
| sage-eval-ww1-OR2xCB | 21 | 21 | 0 (0%) |  |  |
| sage-eval-ww1-zTrA5y | 75 | 75 | 0 (0%) |  |  |

## Reading

- Math (calc, terra-graded runs uTb1O9 and FOzeXn): 0.8–1.6× the estimate. The estimate is about right there.
- Written-answer domains (Spanish, biology, first aid, WW1 history): 2.5–4× the estimate. These ledgers are all-flash runs, so domain and grader are confounded: part of the gap may be flash grading, not the domain.
- Adaptive runs spend only 6–19% of attempts on items that can't advance the gate (the 95% rows are the fixed baseline tutor, which drills free recall by design). So the overrun is mostly failed attempts (a failed latest attempt blocks the pass) and repairs, not wasted items.
- The clock in these evals is synthetic (choice 30 s, text 75 s, reading 200 wpm), so only attempt counts are evidence here, not minutes.

## Consequence for the planner hint

The hint (PLANNER_FIT.md) makes plans fit the *estimate*. In written-answer domains real sessions take 2–4× that, so plans that "fit" will still overrun. Fix options (owner decision; ED-29 is owner-approved): a higher RETRY_FACTOR for open-answer subskills, or ITEM_MIN split by activity type as the owner already asked for once there is real data. Next measurement: a terra-graded ww1 run (when the OpenAI limit resets) to separate grader from domain.
