# Grader prompt ablation (flash, 2026-11-08)

Five general rules added to the grader prompt (owner: "make the prompting more harsh"), tested on flash, 3 repeats each on all 30, under the owner's 2026-11-08 gate. `only-X` = old prompt + rule X; `drop-X` = all rules except X. The rule texts are the ones now in `GRADER_SYSTEM` (packages/agent/src/grader.ts); variants were run with `PROMPT_FILE=<variant> bun packages/eval/calibration/run-grader.ts`.

Rules: **ties** (when torn, give the lower credit), **implied** (implied ideas ≤ 0.5), **ambiguous** (wording readable as right or wrong ≤ 0.5), **diagnosis** (wrong diagnosis → identify/explain criteria 0), **terms** (every imprecise term gets its own precision flaw).

| variant | A1–A10 MAE | A1–A10 signed | C01–C20 MAE | C01–C20 signed | items > +20 (per repeat) | repeats passed | A7 | A8 | C04 |
|---|---|---|---|---|---|---|---|---|---|
| all | 7.2 | +3.7 | 3.9 | -1.8 | A8/A8/none | 1/3 | 33|90|33 |
| base | 7.0 | +4.8 | 4.2 | -0.1 | A8/A8,C04/A8 | 0/3 | 36|93|39 |
| drop-ambiguous | 6.9 | +3.0 | 5.4 | -0.7 | A8,C17/A8,C17/A8,C17 | 0/3 | 33|94|33 |
| drop-diagnosis | 7.3 | +3.7 | 6.0 | -1.4 | A8/A8,C17/A8,C04,C15 | 0/3 | 33|93|39 |
| drop-implied | 5.8 | +4.4 | 4.5 | -2.3 | A8/A8/A8 | 0/3 | 42|93|33 |
| drop-terms | 6.0 | +2.8 | 4.2 | -2.1 | A8/A8/A8 | 0/3 | 33|94|33 |
| drop-ties | 6.7 | +3.9 | 5.3 | -1.9 | A8/A8/A8 | 0/3 | 33|93|33 |
| only-ambiguous | 5.9 | +4.9 | 3.9 | -0.8 | none/A8/A8 | 1/3 | 43|85|33 |
| only-diagnosis | 6.9 | +5.9 | 4.2 | +0.3 | A8,C04/A8/A8,C04 | 0/3 | 50|93|44 |
| only-implied | 7.6 | +3.9 | 4.4 | -2.2 | A8/A8/A8 | 0/3 | 33|93|33 |
| only-terms | 6.9 | +5.5 | 4.7 | -0.4 | A8/A8,C04/A8 | 0/3 | 45|90|39 |
| only-ties | 6.2 | +4.0 | 3.4 | -2.5 | A8/A8/A8 | 0/3 | 36|93|22 |

Targets: A7 42, A8 65, C04 17.

- Flash gives A8 full credit on all four criteria in every variant (85–94); the prompt's "clear claim" and "follows from" rules don't change that. Flash can't pass on prompting alone.
- Differences between single rules on flash are about the size of run-to-run noise (A7 33–50, C04 22–44), so flash can't rank the rules. Use terra for further prompt work.
- All rules together on terra: MAE 2.9–3.2 (was 4.7–5.3), C04 / A7 / C08 fixed, 2/3 repeats pass (repeat 1: A1–A10 signed +3.2, from A2 67 and A8 68).
