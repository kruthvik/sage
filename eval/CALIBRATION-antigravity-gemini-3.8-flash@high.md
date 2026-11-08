# Grader calibration: antigravity/gemini-3.8-flash@high

2026-11-08T01:08:31.223Z · repeats 2 · 408 s wall · tokens in 53121 / out 88493 · cost $0.0407
Score = 100 × mean criterion credit − precision deductions (met criteria only) − min(polish, 4), computed in code from the model's judgements.

## A1–A10 (owner-scored, final; this is the gate)

n=9/10 · MAE 8.4 (≤8) · mean signed +0.9 (≤+3) · lenient ceiling violations: none · **FAIL**

| id | target | score | Δ | runs | validity problems | error |
|---|---|---|---|---|---|---|
| A1 | 94 | 100 | +6 | 100, 100 |  |  |
| A2 | 55 | — | — |  |  | role call hit the 4096-token output limit; ask for less per call |
| A3 | 88 | 90 | +2 | 90, 90 |  |  |
| A4 | 5 | 0 | -5 | 0, 0 |  |  |
| A5 | 75 | 75 | +0 | 75, 75 |  |  |
| A6 | 90 | 93 | +3 | 93, 93 |  |  |
| A7 | 55 | 26 | -29 | 26 |  | role call hit the 4096-token output limit; ask for less per call |
| A8 | 65 | 86 | +21 | 86, 86 | needed retry |  |
| A9 | 15 | 25 | +10 | 25, 25 |  |  |
| A10 | 0 | 0 | +0 | 0, 0 |  |  |

## C01–C20 (Claude-written, UNREVIEWED; informational until the owner confirms)

n=18/20 · MAE 11.3 (≤8) · mean signed +1.4 (≤+3) · lenient ceiling violations: none · **FAIL**

| id | target | score | Δ | runs | validity problems | error |
|---|---|---|---|---|---|---|
| C01 | 30 | 50 | +20 | 50, 50 |  |  |
| C02 | 100 | 100 | +0 | 100, 100 |  |  |
| C03 | 93 | 99 | +6 | 99, 98 |  |  |
| C04 | 35 | — | — |  |  | role call hit the 4096-token output limit; ask for less per call |
| C05 | 86 | 60 | -26 | 60, 60 | needed retry |  |
| C06 | 98 | 100 | +2 | 100, 100 |  |  |
| C07 | 20 | 33 | +13 | 33, 33 |  |  |
| C08 | 72 | 83 | +11 | 83, 83 | needed retry |  |
| C09 | 15 | 26 | +11 | 26, 26 |  |  |
| C10 | 0 | 0 | +0 | 0, 0 |  |  |
| C11 | 76 | 92 | +16 | 90, 93 |  |  |
| C12 | 10 | 0 | -10 | 0, 0 |  |  |
| C13 | 78 | — | — |  |  | role call hit the 4096-token output limit; ask for less per call |
| C14 | 15 | 33 | +18 | 33, 33 |  |  |
| C15 | 40 | 0 | -40 | 0, 0 |  |  |
| C16 | 86 | 76 | -10 | 76 |  | role call hit the 4096-token output limit; ask for less per call |
| C17 | 35 | 50 | +15 | 50, 50 |  |  |
| C18 | 79 | 76 | -3 | 76 | needed retry | role call hit the 4096-token output limit; ask for less per call |
| C19 | 0 | 0 | +0 | 0, 0 |  |  |
| C20 | 97 | 100 | +3 | 100, 100 |  |  |
