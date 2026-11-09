# Memory (2026-11-08)

Owner: a 3-hour real session has to survive. Every role and the simulated learner on antigravity/gemini-3.8-flash.

## Verdict: flat, no leak found

- **calc, adaptive, `cram-eval.ts` in the foreground** (`MEM_LOG=<file>`, stopped at 590 s by the tool's 10-minute limit): RSS held at 165–169 MB for 8 minutes. One 234 MB peak at 510 s fell back within a minute. Heap without a forced GC sawtoothed between 32 and 58 MB.
- **`sage serve` soak** (`packages/eval/src/serve-soak.ts`): the real server in-process on a virtual clock, with a simulated learner driving it over the WebSocket. It ran 61 virtual minutes in 1,373 s wall time: 88 learner steps, 300 events, 93 model calls, 0 client errors, export OK. RSS went from 164 to 174 MB (+10 MB). Live heap after a full GC went from 28 to 32 MB (+4 MB). The growth is the session's own state (attempts, timeline, items). After a full GC the extra objects number about 1,700 plain objects and 1,100 arrays, with no growing class of sessions, buffers or source text.
- Extrapolated to 3 hours at the soak rate: about +30 MB RSS. Not a risk.
- **Checked by reading the code:**
  - Every pi session is disposed in a `finally`: one per tutor turn and one per research call. One-shot role calls open no session; they are a single completion call.
  - Research services are now created per call (d9e6582), so the extension state of finished sessions isn't kept.
  - The server keeps one driver per session, and socket and lease entries are removed on close.
  - The ledger is SQLite, and replay happens only on resume and in `usage.get` (a known shortcut).
  - Source text is in SQLite, not in memory.
- The background runs of this unit were stopped by Claude Code because the whole machine was low on memory. At 165–175 MB, Sage was not the cause.

## serve soak, sampled every 30 s (live heap after a full GC)

| wall s | virtual min | RSS MB | live heap MB |
|---|---|---|---|
| 0 | 0.0 | 185.3 | 37.5 |
| 30 | 0.0 | 173.3 | 31.7 |
| 60 | 0.0 | 170.9 | 32.1 |
| 90 | 1.5 | 168.9 | 29.1 |
| 120 | 1.5 | 166.6 | 28.3 |
| 150 | 2.1 | 164.4 | 27.7 |
| 180 | 2.1 | 164.2 | 27.6 |
| 210 | 3.6 | 164.3 | 28.1 |
| 240 | 3.6 | 164.5 | 28.6 |
| 270 | 5.1 | 165.4 | 29.2 |
| 300 | 6.6 | 165.9 | 29.0 |
| 330 | 8.1 | 166.4 | 29.4 |
| 360 | 9.6 | 167.8 | 30.3 |
| 390 | 9.6 | 165.8 | 28.5 |
| 420 | 11.1 | 166.5 | 29.2 |
| 450 | 11.1 | 165.5 | 28.5 |
| 480 | 12.6 | 167.1 | 30.2 |
| 510 | 13.3 | 166.1 | 30.2 |
| 540 | 13.3 | 165.8 | 28.1 |
| 570 | 20.1 | 168.5 | 30.6 |
| 600 | 23.8 | 167.8 | 30.1 |
| 630 | 24.6 | 170.0 | 29.8 |
| 660 | 25.9 | 169.3 | 30.2 |
| 690 | 27.4 | 169.5 | 30.2 |
| 720 | 28.9 | 169.6 | 30.8 |
| 750 | 32.5 | 170.2 | 30.7 |
| 780 | 34.0 | 170.2 | 30.4 |
| 810 | 34.0 | 170.8 | 30.8 |
| 840 | 34.6 | 169.8 | 30.5 |
| 870 | 36.1 | 171.3 | 30.7 |
| 900 | 39.1 | 171.6 | 30.8 |
| 930 | 40.6 | 170.5 | 31.1 |
| 960 | 40.6 | 170.8 | 31.1 |
| 990 | 41.1 | 171.2 | 30.7 |
| 1020 | 41.1 | 169.8 | 29.2 |
| 1050 | 41.1 | 169.6 | 28.9 |
| 1075 | 41.1 | 169.7 | 29.0 |
| 1105 | 41.9 | 170.3 | 30.1 |
| 1135 | 48.6 | 172.0 | 31.2 |
| 1165 | 49.9 | 171.4 | 31.0 |
| 1195 | 50.1 | 171.4 | 30.6 |
| 1225 | 53.1 | 172.7 | 31.0 |
| 1255 | 53.1 | 171.6 | 30.5 |
| 1285 | 54.6 | 171.7 | 30.7 |
| 1315 | 58.4 | 173.4 | 31.1 |
| 1345 | 58.4 | 172.9 | 31.1 |
| 1373 | 61.1 | 173.9 | 31.6 |

## calc adaptive eval, sampled every 30 s (heap without forced GC)

| wall s | RSS MB | heap MB |
|---|---|---|
| 0 | 51 | 3 |
| 30 | 168 | 38 |
| 60 | 169 | 35 |
| 90 | 167 | 37 |
| 120 | 165 | 32 |
| 150 | 166 | 34 |
| 180 | 165 | 34 |
| 210 | 166 | 36 |
| 240 | 165 | 37 |
| 270 | 166 | 38 |
| 300 | 166 | 39 |
| 330 | 168 | 40 |
| 360 | 167 | 41 |
| 390 | 168 | 43 |
| 420 | 168 | 43 |
| 450 | 168 | 44 |
| 480 | 174 | 47 |
| 510 | 234 | 54 |
| 540 | 229 | 58 |
| 570 | 215 | 45 |
