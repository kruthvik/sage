# v3 → v4 port map

Source: branch `v3` (commit `39a7c30`, "rename Sato to Sage and finalize v2 learning engine"). The v3 checkout lives at `../sage-v3` (main worktree). Port by copying the file, then cutting it down. Don't re-derive semantics that v3 already got right.

Verdicts: **keep** (port, simplify), **rewrite** (same job, new design), **drop**, **ask** (owner decides; see `PROGRESS.md`).

## Ledger and evidence (the part v3 got right)

| v3 | Verdict | v4 home | Notes |
|---|---|---|---|
| `storage/src/store.ts` (61K) | keep | `packages/storage` | 7 tables, WAL, immutable-write triggers, migrations, content hashes, stable op IDs, correction chains. Port as is, then add v4 revision kinds (plan, node, item, grade, pace). Its `learning_define` semantic validation moves behind engine events. |
| `storage/src/projection.ts` (25K) | keep | `packages/storage` | Rebuildable reducer with sequence and time cutoffs. Component views become subskill views keyed by the 7 dimensions. |
| `storage/src/review-validation.ts` | keep | `packages/storage` | Review consent and completion rules. Used by whichever scheduler wins (Q1). |
| `core/src/contracts.ts` (18K), `learning.ts` | keep | `packages/core` | Typebox schemas. Reconcile with SPEC §6. Keep assistance stages, family metadata, `variation` contract, hypothesis revisions, decision record (rejects unknown fields, so no hidden CoT). |
| assistance semantics (in store/projection) | keep | `packages/engine/src/evidence.ts` | Offered / requested / exposed / possibly-exposed, answer-bearing flag, record-before-reveal, feedback contaminates dependent steps, key view ⇒ supported. |
| exposure family + cosmetic fingerprint (`projection.ts familyKeys`) | keep | `packages/engine/src/families.ts` | Numbers normalised, so a numeric substitution is the same family. |
| transfer variation contract | keep | `packages/engine` + validator | Pinned, previously delivered baseline + changed dimensions + invariant. Surface-only can't claim changed_application. |
| hypotheses (`projectHypotheses`) | keep | `packages/engine/src/hypotheses.ts` | Supporting/contradicting IDs; contradiction weakens; resolution needs contradicting evidence. |
| `runtime/src/candidates.ts` | keep | `packages/engine/src/candidates.ts` | ≤4 + checkpoint, transparent priority order. Inputs change from components to the node-loop state. |
| `runtime/src/context.ts` (22K) | keep, cut down | `packages/agent/src/context.ts` | Char cap, omission list, ID drill-down. The cap drops 16,000 → 12,000 and the layout follows SPEC §12.2 (stable prefix first). |
| `runtime/src/reviews.ts` | ask (Q1) | `packages/engine/src/scheduler.ts` | v3 transparent baseline: 2 days, doubles on delayed success, resets on failure. |
| `runtime/src/evaluation.ts` | keep | `packages/eval` | Descriptive reports. |
| `runtime/src/feedback.ts` | keep | `packages/engine` | Review-before-advance receipt (`assertCanAdvance`). |
| `runtime/src/disclosure.ts`, `pi/src/context.ts` | keep | `packages/agent` | Provider disclosure gate, image normalisation. |

## Pedagogy flow (rewritten)

| v3 | Verdict | v4 home | Why |
|---|---|---|---|
| `resources/prompts/planner-policy.md` | rewrite | `packages/agent/prompts/planner.md` | Line 8 caps plans at 3 components / 1–4 activities, which is F2. v4 plans the whole unit as a node DAG. |
| `resources/prompts/tutor-policy.md` (8K) | rewrite | `packages/sage-extension/policy.md` | Negation-heavy (F14). v4 uses a short positive procedure, ≤2.5k tokens. |
| `resources/skills/learning/SKILL.md` (21K) | drop | – | Rules move into host code. Useful nuggets go into the policy or `LIBRARY_CANDIDATES.md`. |
| `runtime/src/learn-flow.ts`, `learn-step.ts`, `learn-controls.ts`, `learning-controller.ts`, `learning-state.ts`, `teaching.ts`, `lesson-preparation.ts` | rewrite | `packages/engine/src/loop.ts` | Becomes one node-loop state machine plus the dimension gate. v3's three-check gate becomes K. Control semantics carry over (teach / practice / advance / gaps / stop; blank input never fabricates work). |
| `runtime/src/practice-policy.ts` | rewrite | `packages/engine/src/modes.ts` | `learnReadiness` becomes the gate; `examFormats` goes into the blueprint. |
| `runtime/src/cram.ts`, `drill.ts` | rewrite | `packages/engine/src/modes.ts` | Mode presets over one loop. Keep cram's "every original gap gets a fresh independent recheck" and drill's source priority order. |
| `runtime/src/assessment.ts` (protected tasks) | keep idea | item bank `assessment` partition | Held-back items. |
| `runtime/src/planning.ts`, `pi/src/planner.ts` | rewrite | `packages/agent/src/roles.ts` | Keep `runBoundedPiChild` (one request, ≤4,096 output tokens, 60 s deadline, cancelable) as the generic role-call transport. |
| grading inside tutor | rewrite | grader role | F1. |
| `core/src/experience.ts` (profiles, preview) | keep | `packages/core` | Becomes `LearningPreview`. |
| `core/src/subjects.ts` (7 profiles) | keep registry only | `packages/core` | `registerSubjectAdapter` stays; subjects become planner hints, not code paths. |
| `core/src/status.ts` | rewrite | `packages/exports` | Becomes `session.md`. |
| `/exam` mode | ask (Q2) | blueprint | Default: fold into the exam blueprint. |

## Activities and capabilities

| v3 | Verdict | v4 home | Notes |
|---|---|---|---|
| `pi/src/feynman.ts`, `core/src/feynman.ts`, `prompts/feynman-policy.md` | keep, reshape | `packages/agent` | One call returns follow_up + gaps + explanation grade (SPEC §7.4). |
| `pi/src/interactions.ts` (18K), `runtime/src/interactions.ts`, `core/src/interactions.ts` | keep semantics | `packages/activities` | MCQ with hidden keys. Native selector/editor flows become API-driven components. |
| `runtime/src/submissions.ts` | keep | `packages/activities` | Image admission, consent, vision check, confirmed transcription. |
| `runtime/src/ui/compiler.ts`, `server.ts`, `client.js`, `design.css`; `skills/ui/SKILL.md` | keep + extend | `packages/activities/src/ui` | Add mcq, numeric, ordering, matching, hotspot, mermaid, plot, slider, math (M5). |
| studio approval in `service.ts` (`StudioApproval`) | drop | – | Replaced by host-checked necessity criteria + log (SPEC §7.5). |
| `runtime/src/diagram.ts`, `core/src/diagram.ts`, `pi/src/diagram.ts`, `prompts/diagram-policy.md`, `skills/visualize` | keep | `packages/activities` | Diagram as a representation change after failure. |
| `integrations/src/registry.ts` | keep | `packages/capabilities` | calculate, graphSvg, validateDrawing, honest unavailable states. |
| `activities/src/validation.ts` (`verifyLinearEquation`) | generalise | `packages/capabilities` | Key verification for anything `calculate` can evaluate. |
| `activities/src/demo.ts`, `fixtures.ts` | keep as fixtures | `packages/eval` | Offline scenarios. |

## Infrastructure

| v3 | Verdict | v4 home | Notes |
|---|---|---|---|
| `runtime/src/markdown-pdf.ts`, `markdown-pdf-worker.ts` | keep | `packages/exports` | pdf-lib, isolated subprocess, no-overwrite. Math rendering to be checked (Q: Typst, M4). |
| `runtime/src/vault.ts` | keep + extend | `packages/integrations` | Add `vaultPath` for the sessions root (M6). |
| `runtime/src/usage.ts`, `pi/src/usage.ts` | keep | `packages/integrations` | total_sessions, total_hours only. |
| `runtime/src/tutor-lock.ts` | keep | `apps/server` | OS-backed SQLite lease. |
| `runtime/src/backup.ts`, `privacy.ts` | keep | `packages/storage` | Restore into a fresh home only. Purge stays. |
| `runtime/src/paths.ts`, `bootstrap.ts` | keep | `packages/core` | `~/.learn` → `~/.sage`, with a one-time migration offer. |
| `pi/src/sdk.ts`, `runtime.ts`, `resources.ts`, `skills.ts`, `shared-runtime.ts`, `plugins.ts` | keep | `packages/pi-adapter` | Sole importer. Isolation, resource loader guard, package provisioning. |
| `pi/src/updates.ts` | keep | `packages/pi-adapter` | Immutable installs, provider-free startup check, atomic selection, rollback. Adds `eval:smoke`. |
| `pi/src/tutor.ts` (85K) | rewrite | `packages/sage-extension` | 5 phase-scoped tools instead of 7 + render_ui + learning_skill. |
| `pi/src/presentation.ts` (TUI renderers) | drop | – | No TUI. |
| `pi/src/intake.ts`, `journal.ts`, `source-folder.ts`, `research.ts` | rewrite | API methods | Native-TUI flows become `session.create`, `sources.*`. |
| `runtime/src/service.ts` (61K loopback IPC) | rewrite | `apps/server` | WebSocket JSON-RPC. Keeps auth-token + origin rejection + "tools can't fabricate learner_response". |
| `runtime/src/tutor-host.ts` | rewrite | `apps/server` | |
| `runtime/src/artifacts.ts` | keep idea | `packages/exports` | Provenance-bearing artifacts. |
| `sources/src/service.ts` + untracked `captions.ts`, `pdf.ts`, `pdf-worker.ts`, `office.ts`, `raster.ts`, `limits.ts` | keep | `packages/sources` | The untracked files were hidden by v3's `.gitignore` (`sources/` matched the package). Ask whether they're meant to ship (Q, M6). |
| `apps/cli` (~40 subcommands), `customization.ts` | drop | – | Only `sage`, `sage serve`, `sage doctor`, `sage update`. Settings move to the API/GUI. |
| `scripts/check-publication.ts` | keep | `scripts/` | Copied. |
| `brain.md` | keep | root template | Copied. Never overwrite a personal copy. |

## Tests

Port the v3 tests for each kept subsystem: ledger, replay, corrections, assistance contamination, families/cosmetic variants, transfer variation, hypotheses, candidates, context caps, UI compiler, PDF, vault, lease, update/rollback, backup/restore. Drop TUI/native-CLI tests. Rewrite learn-flow/controller tests (102K + 49K) as node-loop and persona tests.
