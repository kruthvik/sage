# Deferred

Parked by owner decision (2026-11-07: "short-term learning first"). The data model stays multi-session compatible, so none of these needs a migration.

| Item | Current state | Where it would go |
|---|---|---|
| Review scheduling UI and reminders | v3 baseline intervals computed (`engine/src/scheduler.ts`); review cards created at node pass and need consent; nothing schedules or notifies | server + GUI |
| Multi-session planning (resume a unit across days, re-plan from a gap report) | sessions resume; no cross-session plan | planner role + engine |
| Retention dashboards / delayed-check reporting | retention dimension only counts after ≥1 day; LTR shown as "predicted (unmeasured)" | exports |
| Learn mode extras (more representations, slower fading, review schedule at end) | preset values only | `pedagogy.config.ts` |
| Drill extras (error-type report beyond the basic one, continuous mixed rounds UI) | preset values only | exports |
| Accelerate extras (diagnostic ≤12 min UX) | test-out rule implemented | engine |
| whisper.cpp local transcription of the learner's own audio/video files | not built; YouTube uses a pasted transcript, and .vtt/.srt files are read directly | sources intake (a local whisper.cpp binary + model, run as a bounded subprocess; nothing uploaded) |
| Voice recall | `ResponseInput.audio_transcript` shape only | activities |
| General-purpose tutor subagents | rejected; the only subagent is `researcher` | – |
| `ui-bridge.ts` (pi extension UI → client) | missing; pi's no-op UI is used, so headless works but extensions that need UI (dialogs, prompts, widgets) don't. The original goal was "pi without the TUI, extensions keep working" (owner, 2026-11-08: revisit when the GUI phase starts) | `pi-adapter` + `ui.respond` in API.md |
| ED-29 minute estimates split by activity type | one set of per-dimension minutes; long-form open answers (ww1 history) take far longer than numeric ones (owner, 2026-11-08: split once there's real session data) | `pedagogy.config.ts` (`ITEM_MIN`) + `pacing.ts` |
