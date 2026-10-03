# Learning engine v2

## Authority and durable records

Pi owns conversation, tutoring, semantic planning, activity generation, assessment proposals and selection among valid next actions. The existing bounded Pi planning child still handles intake and consequential replanning; no per-answer agent fan-out was added. Bun owns validation, dates, deterministic objective scoring, persistence, projections, candidate features and local tool adapters. No model client or autonomous tutor lives in the state layer.

SQLite schema 2 adds three indexes to the existing seven tables. No canonical row is rewritten or deleted. Revision schema versions identify new writes; optional contract fields preserve old bodies. Backups accept schema 1 and 2; opening an older store migrates incrementally. Newer unknown schema versions are rejected. Projector 2 is rebuildable from immutable revisions/events with explicit sequence/time cutoffs. Corrections supersede effective observations but leave past-sequence queries unchanged. Hypothetical branches do not establish learning.

## Component state

Each exact component revision derives separate acquisition, independent, supported and uncertain summaries. Retention records actual independent checks and actual delay since relevant practice/help; the default meaningful-delay floor is one day, optionally component-specific. An immediate retry labeled retention gets no delayed credit. Failures remain visible, and time alone never creates a failed observation.

Transfer records independently attempted application under reviewed, explicitly changed conditions. A task variation pins a previously delivered baseline, lists changed dimensions and explains the invariant/rationale. Surface-only changes, an unseen baseline, legacy free-text `changes`, and calculator-only key verification do not establish transfer. Human/curated review of the task is required for the variation claim. These are conditional changed-application observations, not certified far transfer or externally validated item equivalence.

Discrimination, explanation, execution and fluency require explicit, scoped assessment claims with quotes from the actual response. A final number is not evidence of method choice or reasoning. Claims remain attributed rubric proposals; fluency requires genuine appropriate measurement, not response-latency inference. Optional `component_outcomes` prevent a holistic result from silently crediting every targeted component. Omitted components become `not_observed`.

Assistance includes offered/requested/authorized/exposed/possibly-exposed stages, answer-bearing content and task/component/attempt/step scope. Offers and non-answer-bearing accessibility aids do not contaminate independence. Unknown or unauthorized external aids preserve uncertainty. Feedback can contaminate later dependent steps; their assessments quote their own response and never add holistic repetitions. Re-delivering an identical prompt after solution-bearing help does not magically make it fresh independent work. Allowed-aid conditions remain recorded, without arbitrary hint penalties.

Guidance states summarize observed support and outcomes: orientation, example, scaffolding, fading, familiar independence, independence across successfully sampled forms, retention, or changed application. Components do not have to pass through every state. These are provisional component-specific descriptions, not global ability labels or teaching commands.

Families retain immutable definitions, instances and attempts. Optional metadata describes structural signature, solution structure, method selection, prerequisites, sources, representations, variation and common errors. Lineage/shared signature groups related families even if renamed; cosmetic variants remain narrow practice. Exposure includes unassessed attempts, definitions, successful independent attempts and a dated seven-day recent count. Successful forms—not merely attempted forms—support across-form guidance. Legacy unknown metadata remains unknown. Coverage debt names untested independence, retention, changed application and narrow family/representation sampling, without imposing technique quotas.

## Competing hypotheses

Exposure counters separately record task deliveries, possible/actual assistance and unassessed attempts; none becomes success merely by being present. Exact same-component prompts with only numeric substitutions share an exposure family even if lineage was omitted. Such a cosmetic variant also cannot become transfer by being mislabeled as a structural change. This conservative fingerprint is not a general semantic similarity model.

`learning_define` supports immutable `hypothesis` revisions: component scope, conceptual/procedural/selection/representation/prerequisite/slip/unknown category, qualitative confidence, supporting and contradictory assessment IDs, first/last dates, status, optional competing hypotheses and prerequisite target. Evidence must be an actual relevant assessment. An event cannot support and contradict the same revision; unsupported resolution is rejected.

Projection selects the latest revision at the requested sequence/time. Corrected/not-observed/hypothetical evidence is removed from effective support. Contradictions weaken the hypothesis; an explicit resolved revision requires contradictory evidence. Sparse/no effective support becomes uncertain. Semantic descriptions and evidence links remain proposals; Bun does not diagnose the learner by reading their prose. A prerequisite edge alone does not establish a blockage.

## Candidates, policy and decisions

Bun proposes at most four substantive candidates plus a checkpoint. Features are qualitative/ordinal: active-goal relevance, near deadline, evidence uncertainty, observed support dependence, review need, transfer/selection gaps, family overexposure, coverage debt and rough cost. They are decision aids, not probabilities. Pi can choose another justified move or honor the learner's override. Bun never runs the highest-ranked action.

The transparent-2 fallback prioritizes stop/constraints and task reliability; evidenced prerequisite repair or discriminating hypotheses; less-supported fresh work after help; error-sensitive correction; meaningful varied application/selection; useful delayed retrieval; conditional advance and sensible checkpoints. Sparse data offers orientation and an example only if a meaningful attempt is not yet possible. Repeated failure proposes another representation/reassessment, not endless repetition. Exam relevance and actual format matter; `/exam` is not an MCQ mode. Optional exam metadata retains format, syllabus, component importance, timing and grading criteria.

Retrieval, worked examples, completion, teach-back, MCQs, open response, contrast, interleaving, prediction, error correction and generation are opportunistic tools. Teach-back can expose vague causal links but does not prove mastery. Method-selection practice differs from execution; mixing presupposes sufficient foundations. Writing evaluates arguments/warrants holistically; practical/voice claims require observable modality evidence. No diagrams-per-lesson, MCQs-every-N-tasks, learning styles, universal mastery threshold or forced strategy rotation.

Significant Pi decisions can record policy version, considered candidate IDs, selected candidate, target components, evidence IDs, reason codes, uncertainty, user override and observed model-call association. Unknown fields—including hidden chain-of-thought—are rejected. Host capability decisions also log explicit reasons. These are declared reasons, not private model reasoning.

## Review baseline

Review proposals do not schedule anything or imply forgetting. After an independent success, offer an initial two-day interval, bounded by the goal horizon, component minimum delay and the day before an actual deadline. A successful delayed check can double its observed interval within the horizon; delayed failure returns to the minimum offer. Recent relevant practice/help resets the offer's anchor. Short deadlines may leave no meaningful later check.

These exact numbers are convenient engineering defaults, not empirically optimal intervals or an FSRS model. Scheduling needs a future date and captured learner consent in the same conversation. Completion requires a matching retention attempt after that date; it records a completed check even if the outcome fails. Pi chooses recall for declarative targets, fresh problem/application for procedures, argument reconstruction for writing, debugging for computing, etc. No automatic reminder or background model loop exists.

## Tiny context and drill-down

Default packets have a hard 16,000-character limit, at most four task/outline-relevant components, three hypotheses/review offers and five candidates. Summaries retain counts and a few evidence IDs; legacy observation arrays retain only the latest observation. Current response previews are capped at 1,200 characters and preference notes at 1,800. Omissions are explicit; budget pressure removes lower-priority items rather than leaking the whole history. Database history remains rich and local.

`learning_context` accepts exact component IDs, up to five evidence event IDs, three hypothesis revision IDs, a task instance, sequence, time and budget. Drill-down stays budgeted; a very long response may need a larger bounded budget. Source-linked evidence is checked against current acceptance/sharing even for historical reads. Full raw keys/history are not dumped into Pi. The native Pi session may still retain its own conversation; packet limits do not purport to eliminate all conversational history or Pi's native compaction.

## Capabilities and artifacts

`learning_source action=capabilities` reports actions, types, permissions, reliability, artifacts, provenance, evidence limits and fallback. The existing four-tool interface stays intact.

Currently implemented:

- `calculate`: bounded numeric grammar (+, -, *, /, ^, parentheses, common functions), no eval, files or network. Floating-point arithmetic is not symbolic algebra, unit checking or proof.
- `graph`: a local SVG of explicit y=f(x), 161 samples on x/y [-10,10]. Discontinuities can be missed. It is a comparable small graph artifact, not connected Desmos or a learner-graph comparison service.
- `drawing`: bounded [Excalidraw JSON](https://docs.excalidraw.com/docs/codebase/json-schema/) normalization and geometry validation. Links, custom data and embedded files are removed; unknown element creation time stays null. This is a file adapter, not live canvas control or a visual-relation observer.
- Accepted/selected source retrieval and individual Markdown-note import, including notes from a vault. No Obsidian write-back or continuous vault ingestion.

Capability writes require a stable operation ID, current goal and bounded input. Tutor-created outputs are immutable `artifact` revisions and possible task assistance, never learner performance. Task definitions referencing non-learner artifacts conservatively record possible support. Failed verification returns an explicit fallback. Native text mode does not automatically open SVGs or a drawing canvas.

```sh
learn capabilities
learn artifact add drawing my-diagram.excalidraw TASK_INSTANCE_ID
learn artifact add code solution.ts TASK_INSTANCE_ID
learn artifact show ARTIFACT_REVISION_ID
learn artifact export ARTIFACT_REVISION_ID graph.svg
learn evaluate
```

Learner imports are explicit local controls with captured submissions and self-declared provenance; file existence alone is not semantic understanding, executed code or audio delivery. CLI exports refuse overwrite. Artifact IDs survive retries. Pi cannot forge learner authorship or direct modality evidence.

`learning_source action=artifact` retrieves a current-goal artifact by `artifact_revision_id`, with authorship, provenance, interpretation limits and a capped 6,000-character content preview. Removed/unselected task sources block that read. Raw local-file submissions remain in captured immutable response records; normalized drawing artifacts can simplify styling. Geometry/file inspection is not an independently verified semantic relation or skill score.

Unavailable/deferred: live Desmos/whiteboard inspection, sandboxed code execution, symbolic CAS/unit verification, live voice/pronunciation/prosody, trusted web retrieval, Obsidian synchronization. A capability registry interface represents them honestly and provides text fallbacks. Reviewed Pi extensions can add actual tools; they have OS privileges and need real permission/security design.

## Extension interfaces and evaluation

Pi native packages/skills/extensions/themes and isolated update/rollback are unchanged. A subject adapter can declaratively override a coarse category's profile via `registerSubjectAdapter`/`subjectAdapterFor`; target behavior remains primary, not the subject name. This trusted-code API does not auto-load arbitrary source instructions. `CapabilityRegistry.register` accepts typed trusted adapters with explicit permissions and reliability; the installed host only wires its verified built-ins into educational operations. New Pi tools can use that API in trusted integration code. Custom schedulers/projectors can replace pure proposal/reducer modules while preserving canonical history and versioning; no dynamic untrusted scheduler loader was added.

`learn evaluate` reports dated component outcomes, actual delayed checks, support exposures, family/representation coverage, error categories, reviews, declared decisions/overrides/abandonment and checkpoints. Optional work seconds are learner-reported. Calendar time to first independent success is explicitly not learner work time; missing time and abandonment remain unknown. Metrics do not optimize engagement or claim a policy caused improvement.

Offline scenarios cover integration-method selection, chemiosmosis and phosphorylation discrimination, and historical warrant repair. Tests also cover historical correction/replay, dependency contamination, narrow families, meaningful delays, hypotheses, candidates, compact context, capability denial/authorship, idempotency and migration/restore. Actual learning impact still needs matched content/time/support baselines, independent delayed/changed-application outcomes and appropriate human/content review. The research corpus qualifies technique effects and is incomplete; policy triggers remain experiments, not an established optimal engine. `/accelerate`, standalone `/drill`, learned scheduling, large practice banks and privacy purge remain deferred.
