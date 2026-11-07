# Interactive learning activities

Implemented: native Pi MCQ selection, Feynman inversion through a bounded Pi child, and prompted image/typed scrap-work submission. These are primarily AI-invoked activities within the existing lesson, not user-managed learning modes or a technique rotation.

## Use

The tutor calls `learning_activity` itself when an MCQ or teach-back would help the current lesson. It resolves the target from the current working outline, active component/task and recent evidence, selects/prepares a suitable reviewed task, opens the UI, interprets the actual response and continues the lesson. Learners need not type commands or locate task IDs. Activity format does not override goal alignment, review requirements or assistance semantics.

Optional `/mcq` and `/feynman` shortcuts send a request to the same tutor for an activity on what is currently being learned, even if no matching task has been prepared. An optional phrase focuses the request: `/mcq method selection` or `/feynman proton gradient`. They do not directly pick a stored task, start another mode, repeat intake or replan the curriculum. The tutor still honors existing task/source review; it cannot fabricate approval. `/scrap [TASK_INSTANCE_ID]` remains an optional native-editor prompt for the current task, also callable by the AI through `learning_activity`.

- MCQ: arrows select a choice; Enter submits; Esc cancels. The tutor may ask why when useful, not by quota.
- Feynman: explain in your own words in the multiline editor. A separate curious-novice Pi child asks one short clarification. The parent can repair a gap, then test application on fresh work.
- Scrap work: return to the main editor, paste a photo with Ctrl+V or attach its local file path, add optional text, then Enter. You may type instead or say skip. Clipboard behavior depends on Pi/platform/terminal keybindings; file attachment is the fallback. Use a vision-capable model. Sage asks before sending each message's images to the provider. Photos remain in the local private Sage home and backups.

Print mode does not invent answers to UI dialogs. It returns the public prompt and requests ordinary text interaction rather than requiring commands. Interactive/RPC UI uses Pi's public selector/editor APIs. Clipboard-image paste is native TUI behavior, not a custom Sage clipboard service.

## Contracts and authority

`learning_activity` takes `{action, operation_id, expected_goal_revision_id, instance_revision_id}`. Operation IDs are at most 120 characters to leave room for deterministic receipt prefixes. Actions are `mcq`, `feynman`, and `scrap_work`. Bun validates current sharing consent, exact goal/task revisions, task availability and selected/accepted sources, and exposes only the public prompt/criteria/choices. It never runs the child or chooses a teaching strategy.

MCQ task definitions use `format: "mcq"`, `choices: [{id,text}]` (2–8 distinct IDs/texts), `scoring: "exact"`, and `answer` containing the keyed choice ID. The key remains excluded from public context and UI. Existing generated-task review remains mandatory; reviewing a key contaminates independence. Exact scoring matches the actual captured choice, not a tutor success assertion. Selection alone does not establish explanation or fluency. There is no distractor calibration or psychometric validity claim.

The trusted UI bridge captures an immutable learner response and an attempt before returning an MCQ/Feynman receipt. The tutor reuses those IDs for assessment. Cancellation creates neither an attempt nor a failure. Successful retries return the saved receipt, do not re-open the dialog, and do not duplicate evidence. Source/goal changes require refreshing scope.

Feynman inversion reuses the selected isolated Pi SDK/provider/auth runtime. The child sees only the public task, bounded objective/criteria and actual learner explanation. It has no tools, extensions, ambient instructions, persistence or delegation. It is bounded to one request, 4,096 output tokens and a 60-second cancellation deadline. `pi_feynman_request` telemetry distinguishes it from planning/tutoring. The response is strict JSON with a summary, up to three strengths/gaps, verbatim quoted learner spans, one naive follow-up and uncertainty. It does not assign scores/mastery. Only the clarification is shown by the interface; the parent receives the diagnostic proposals. That question is conservatively logged as possibly exposed answer-bearing feedback before display. Failures preserve the explanation. A tool retry with the same operation ID can retry a failed review; saved reviews need no new model call. No claim is made that subagents are intrinsically more effective.

## Images and evidence

Only actual interactive input can create learner image receipts. Model tools cannot submit learner images through the educational API. PNG/JPEG/WebP envelopes require matching file signatures and strict base64, at most four images, 4 MiB each and 8 MiB total per input. Envelope checks are not a full image decoder or malware scanner.

Original bytes are stored by SHA-256 in `data/blobs/` and registered in `blob_manifest`; immutable learner artifacts reference the hash, actual response, goal and optional task. Images are not base64 strings in SQLite or LearningContext. The native Pi input includes the image for the selected vision model's current turn. Context includes only bounded receipt metadata, not alleged OCR. Existing backup/restore includes registered image originals. No new table or destructive database migration is needed.

Image uploads establish an artifact submission, not understanding, verified handwriting, independent authorship or physical execution. Typed captions stay separate from inferred visual interpretation. Ask the learner to confirm unclear handwriting or relations in text before current rubric scoring, which requires genuine learner-text evidence spans. Image-only receipt captions cannot receive success/failure assessments; `not_observed` remains possible until actual learner text is captured. Later history retains the binary artifact, but automatic image rehydration/OCR/search and in-terminal canvas editing are not implemented. Images cannot be submitted from print mode's missing confirmation UI. Denied sharing/nonvision selection stops delivery and offers typed work or another model.

## Verification and limits

Tests cover frozen MCQ choices and hidden keys, real selection/editor capture, cancellation, retry idempotency, exact scoring, source/goal checks, child errors, offline actual-SDK isolation/cancellation, image-only input, consent/nonvision denial, bounded envelopes, artifact provenance and binary backup/restore. Existing Pi update/rollback compatibility checks include the fifth tool.

Human item review, real terminal clipboard support, provider vision reliability and educational effectiveness need evaluation with the actual learner/content/provider. These tests do not establish improved retention or transfer. No forced MCQ/Feynman/image frequency, OCR certainty, learning styles or universal mastery threshold is introduced.
