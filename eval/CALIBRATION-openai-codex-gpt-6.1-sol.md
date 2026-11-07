# Grader calibration: openai-codex/gpt-6.1-sol

2026-11-07T18:09:29.269Z · repeats 2 · 118 s wall · tokens in 37368 / out 15134 · cost $0.2261
Score = 100 × mean criterion credit − precision deductions (met criteria only) − min(polish, 4), computed in code from the model's judgements.

## A1–A10 (owner-scored, final; this is the gate)

n=10/10 · MAE 5.5 (≤8) · mean signed -1.4 (≤+3) · lenient ceiling violations: none · **PASS**

| id | target | score | Δ | runs | validity problems | error |
|---|---|---|---|---|---|---|
| A1 | 94 | 100 | +6 | 100, 100 |  |  |
| A2 | 55 | 58 | +3 | 58, 58 |  |  |
| A3 | 88 | 90 | +2 | 90, 90 |  |  |
| A4 | 5 | 0 | -5 | 0, 0 |  |  |
| A5 | 75 | 75 | +0 | 75, 75 |  |  |
| A6 | 90 | 85 | -6 | 81, 88 |  |  |
| A7 | 55 | 33 | -22 | 33, 33 |  |  |
| A8 | 65 | 63 | -2 | 63, 63 |  |  |
| A9 | 15 | 25 | +10 | 25, 25 |  |  |
| A10 | 0 | 0 | +0 | 0, 0 |  |  |

## C01–C20 (Claude-written, UNREVIEWED; informational until the owner confirms)

n=20/20 · MAE 11.8 (≤8) · mean signed -0.1 (≤+3) · lenient ceiling violations: C11 · **FAIL**

| id | target | score | Δ | runs | validity problems | error |
|---|---|---|---|---|---|---|
| C01 | 30 | 50 | +20 | 50, 50 |  |  |
| C02 | 100 | 100 | +0 | 100, 100 |  |  |
| C03 | 93 | 94 | +1 | 93, 95 |  |  |
| C04 | 35 | 17 | -18 | 17, 17 |  |  |
| C05 | 86 | 67 | -19 | 67, 67 |  |  |
| C06 | 98 | 94 | -4 | 93, 95 |  |  |
| C07 | 20 | 33 | +13 | 33, 33 |  |  |
| C08 | 72 | 63 | -9 | 63, 63 |  |  |
| C09 | 15 | 33 | +18 | 33, 33 |  |  |
| C10 | 0 | 0 | +0 | 0, 0 |  |  |
| C11 | 76 | 100 | +24 | 100, 100 |  |  |
| C12 | 10 | 0 | -10 | 0, 0 |  |  |
| C13 | 78 | 63 | -15 | 63 |  | model reply contained no parseable JSON object |
| C14 | 15 | 33 | +18 | 33, 33 |  |  |
| C15 | 40 | 0 | -40 | 0, 0 |  |  |
| C16 | 86 | 90 | +4 | 90, 90 |  |  |
| C17 | 35 | 50 | +15 | 50, 50 |  |  |
| C18 | 79 | 75 | -4 | 75, 75 |  |  |
| C19 | 0 | 0 | +0 | 0, 0 |  |  |
| C20 | 97 | 100 | +3 | 100, 100 |  |  |
