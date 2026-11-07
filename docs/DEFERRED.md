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
| Voice recall | `ResponseInput.audio_transcript` shape only | activities |
| General-purpose tutor subagents | rejected; the only subagent is `researcher` | – |
