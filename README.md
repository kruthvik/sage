# Sage

A local-first personal learning engine built on Bun and Pi's native terminal. Sage adapts instruction to the learner's goal, actual task evidence, prior help and uncertainty. Independent performance, assisted work, delayed retention and application stay separate.

The implementation follows [outputs/main.md](outputs/main.md), the corrected [learning-science synthesis](outputs/learning-science-final.md) and related research. `outputs/start.md` was excluded. The research motivates bounded techniques; it does not establish that this combined engine is universally optimal.

## Start

Tested on Windows with **Bun 1.4.2** and **Pi 1.0.0**. Pi remains a pinned runtime dependency (`1.0.0`), with a reproducible lockfile and optional independently updatable runtime in Sage's home.

```sh
git clone https://github.com/kruthvik/sage.git
cd sage
bun install --frozen-lockfile
bun run dev init
bun run dev
```

Inside the native Pi terminal:

```text
/login                     Authenticate your chosen provider
/model                     Select a model
/sage linear equations     Choose a learning preview and start
/learn linear equations    Start learning toward independent use
/exam defend my argument   Rehearse an upcoming performance
/status                    Read dated evidence, uncertainty and due reviews
/usage off                 Turn local sessions/open-hours tracking off
/usage status              Show the two local counters; no uploads
/sage-settings             Tracking toggle is the first Sage setting
/mcq                       Optional: ask for an MCQ on the current lesson
/feynman                   Optional: ask to teach a curious Pi subagent
/scrap                     Prompt for a photo or typed scrap work
/studio                    Prepare a lesson-aligned browser activity
/continue                  Open the current native step/checkpoint
/continue teach            Teach without taking a diagnostic
/continue practice         Request more practice after teaching/feedback
/continue advance          Advance only when the host evidence gate permits
/continue gaps             Explicitly leave a target with gaps; confirmation required
/extensions list           Manage this isolated tutor's extensions
/theme list                Choose a native Pi theme
/stop                      Cancel and save a checkpoint
/quit                      Exit
```

Start with what you want to learn, an optional note, then a native preview: radio-style balanced/cram/thorough/custom profiles, independent feature switches, rigorous/focused feedback, review-before-advance and up to 2,000 characters of specific learning parameters. These are editable preferences, not ability labels. Cram starts without a planning subagent by default; planner-off intake asks one primary-subject selection and begins in the main conversation. With planning enabled, Pi infers the subject and prepares a provisional outline. No intake quiz or elaborate planning questionnaire is required. You can change the goal/settings by starting a new preview; historical revisions and submissions remain. An opening check is optional, not a gate; skipping it leaves knowledge unknown. `/exam` also covers essays, interviews, speeches and practical tasks. The learner decides when to stop.

In learn mode, the host supplies one bounded teaching/assessment step. Native free-response practice uses a multiline editor without a webview or subagent. Diagnostic approval is not required for teaching: choose **Teach without a diagnostic** in the review dialog or use `/continue teach`. Your topic stays active, ability remains unknown, and later practice is a separate choice.

MCQs and Feynman inversion are primarily **AI tools inside the lesson**: the tutor chooses a suitable moment, prepares/selects a lesson-aligned reviewed task and opens the interface itself. You do not need to run commands. Optional `/mcq` and `/feynman` shortcuts ask the tutor for that activity on what you are currently learning; an optional phrase focuses the request, such as `/mcq method selection`. No matching task or task ID is required to make the request. Existing generated-task review still applies before delivery. MCQs use arrows and Enter; Esc cancels. Teach-back uses a multiline editor, followed by one curious-student clarification from a bounded Pi child, not a mastery score. For scrap work, paste an image with **Ctrl+V** in the main editor (or attach an image file), then Enter. Pi requires a vision-capable model and Sage asks before sharing the images. Terminal key remapping/interception may require using an image file instead. PNG/JPEG/WebP attachments are limited to four images, 4 MiB each and 8 MiB per message. Typed work and skipping remain available.

Live tutoring requires a Pi-compatible provider. After intake consent, conversation, relevant learning records, up to 1,800 characters of `brain.md` per context packet, and selected source excerpts may go to that provider. Educational records and originals stay local. Pi install telemetry defaults to disabled in Sage settings; native Pi catalog/version/package checks can still contact Pi services. Explicit telemetry settings/environment flags retain Pi behavior.

For a working lesson without credentials or model requests:

```sh
bun run dev demo
bun run dev demo --answers 5,7,9
```

The offline math demo teaches an example, delivers fresh tasks, offers hints and stop, scores numeric answers and reports a checkpoint. Its temporary records are separate from personal history. It tests numbers, not reasoning or retention. The package exposes one executable, `sage`; `bun link` optionally registers it during development. `bun run dev` and maintenance subcommands remain compatible; this repository is not a published install command.

## Local usage tracking

Local usage tracking is **on by default**. It records only **total sessions** and **total hours**. One interactive Sage launch counts once, including a resumed lesson; new conversations within that launch do not add sessions. Help, version, smoke checks and SDK-only sessions do not count. Hours use monotonic elapsed running-app time and include idle time; they do not measure attention or learning.

The small right-aligned status below the editor shows hours and on/off state without replacing Pi's footer. Use `/usage off` to stop counting immediately, `/usage on` to resume, or `/usage status` to inspect the totals. The toggle is first in `/sage-settings`; Pi's `/settings` remains unchanged. Turning tracking off does not erase earlier local totals.

**Nothing is uploaded.** There is no public reporting endpoint in this version. Usage data contains no identifiers, timestamps, prompts, source content, answers, grades, model usage or activity history. This is separate from Pi install telemetry, which remains disabled by default. Totals are saved periodically and on normal exit; a forced exit can lose unsaved time. Invalid, linked or externally edited usage files stop tracking rather than being overwritten.

## Browser activities and feedback

The tutor can prepare a reviewed frozen activity and call `render_ui({source})`, returning a capability URL from the **same authenticated localhost Bun server**. `render_ui({})` loads the UI skill/design on demand without enabling filesystem tools. Open the returned URL; the trusted shell displays the pinned task/criteria, a compact official A2UI interface and an editable raw-response preview. Only declared input fields are copied into that preview, not generated feedback. **Send response to Sage** captures actual work once and resumes Pi for rubric review; cancellation does not manufacture an attempt. Without a frozen reviewed task the UI is preview-only.

Learning preferences live on immutable goal revisions; no new settings database or learning engine is introduced. For opted-in review-before-advance goals, automatic task advancement waits for an overall assessment and trusted native feedback-display receipt. Exact quoted flaws include an explanation, suggested correction and blocking/precision/polish severity. Blocking flaws remain recorded through repair or explicit override; `/stop` remains available. In governed learn, feedback display is not advancement permission: practice, evidence-gated advancement and a separately confirmed gaps override are distinct. Overrides leave grades/uncertainty unchanged. Legacy goals retain their earlier behavior until a new preview is selected. This enforces workflow/quotation structure, not the correctness or completeness of an AI critique or arbitrary conversational prose.

Generated JavaScript is **OFF by default**. Only the trusted shell's **Run custom code** click grants permission with a visible warning. It executes in a restrictive opaque browser iframe, never Bun, but this is **not a strict security sandbox**: it may navigate its own iframe/transmit entered UI data or consume CPU. Do not enter secrets. Its availability conservatively marks submitted work as possibly supported even if code stays off; client feedback/scores are never authoritative learning evidence. UI payloads are bounded in memory (32 entries/30 minutes by default), not persisted as HTML files or a second database. Expiry, server restart, goal/sharing/source changes or stop can invalidate the URL. Math initially renders readable Unicode, not TeX. Provider-free tests and browser QA do not establish learning efficacy.

## Records and personalization

`SAGE_HOME` overrides `~/.learn`:

```text
brain.md                    Learner preferences and constraints
agent/                      Isolated Pi auth/settings/resources/packages
sessions/                   Pi transcripts
pi-runtime/                 Optional checked Pi installs and active selection
data/learning.sqlite        Educational revisions, events and call logs
data/usage.json             Only total_sessions and total_hours; no network reporting
config/usage.json           Local usage tracking on/off preference
data/blobs/                 Untouched source originals
tutor.lock                  Diagnostic owner receipt (not a startup gate)
tutor-lease.sqlite          OS-backed single-tutor lease; released on process exit
```

Sage does not copy normal Pi credentials or discover invocation `.pi` resources/context. Pi's terminal keybindings, diagnostics and theme helpers also use Sage's agent directory, even if `PI_CODING_AGENT_DIR` points to a global instance. Ambient `~/.agents/skills` are excluded unless explicitly opted into through Sage settings. Seven educational tools remain registered; learn requests advertise only phase-relevant tools, alongside tools from reviewed installed extensions; Pi's built-in coding tools stay off. User-installed Pi extensions have OS privileges; isolation is not a sandbox.

Tutor ownership uses a dedicated SQLite connection's OS-level lock, separate from the learning database. Closing or crashing releases it automatically; leftover PID receipts do not require manual removal. Only real lock contention reports another active tutor, while permission/filesystem failures report their actual cause. Leave `tutor-lease.sqlite` in place: deleting a live lock file can defeat cross-process exclusion. When upgrading from an older PID-file-only build, close that old tutor before launching the new version.

The host governs learn sequencing and evidence-gated progression; Pi authors the requested instruction/check or proposes grades for frozen captured work. Other modes retain their existing selection contracts. Fresh public task/rubric/work facts are supplied when available, so the tutor need not repeat broad context or guide reads. Planning is delegated at intake/consequential replanning only when enabled in the learning preview, not after every answer. The child uses the selected Pi model/auth runtime, one request (up to 4,096 output tokens), a 60-second cancellation deadline, and only explicitly supplied bounded facts. It has no tools, user extensions or ambient context. Plans use the existing goal/component/outline ledger; no parallel tutor or new database is introduced. The host formats facts and validates records without generating educational judgments. Seven profiles cover math, writing, science, humanities, languages, computing and practical/creative work. Curated fixtures are teaching examples, not calibrated assessments. Text cannot verify pronunciation, physical performance or laboratory execution.

No global mastery score, learning-style label or fitted forgetting curve is presented as measured knowledge. Reviews require a learner-consent response and date; no unattended reminder/model loop runs.

The tracked [brain.md](brain.md) is a blank boilerplate copied only into new homes. `sage brain edit` edits your private copy; existing notes are never overwritten. Personal home copies remain ignored by Git.

The v2 engine adds distinct component evidence dimensions, revisioned competing error hypotheses, family/representation exposure, guidance fading, transparent review offers and up to five deterministic next-action candidates. In learn, host_learn_step determines the next bounded job; question completion is not broad readiness. Original essential criteria, conceptual/method/changed-application evidence and distinct independent checks support conditional local advancement, never permanent mastery or exam equivalence. Declining a diagnostic does not block explanation. Other modes keep their own contracts. Normal context is bounded to 16,000 characters with ID-based drill-down. [Learning-engine details](docs/LEARNING-ENGINE.md) explain the policy, assistance semantics, integrations, extension interfaces and evaluation limits.

## Sources and practice

```sh
sage source add "C:/path/course-notes.md"
sage source list
sage source preview SOURCE_ID
sage source accept SOURCE_ID
```

In the tutor, `/source attach SOURCE_ID` selects an accepted source for the goal and requests permission to send excerpts to the provider. Other source commands also work in-session. Supported files are UTF-8 `.txt`, `.md`, `.csv`, `.tsv` and `.json`, up to 10 MB. Import preserves originals, creates stable line spans, and exposes `needs_review`. Acceptance confirms extraction, not factual truth. Retrieval is lexical search over quoted, untrusted data. Unknown source rights mean local/private processing; an export does not authorize public redistribution.

Task definitions pin exact components, family, rubric, sources, aids and conditions. Numeric/exact scoring is deterministic; open responses receive Pi rubric proposals with quoted evidence and uncertainty. Generated tasks are candidates. A bounded independent calculator can verify fresh linear equations automatically. Other generated content requires review:

```text
/approve TASK_REVISION_ID           Inspect prompt, criteria and any key
/approve TASK_REVISION_ID confirm   Approve the reviewed task
```

Viewing a key marks that item as supported evidence. The tutor cannot certify its own review, retrieve protected keys or author a protected outcome bank. Fixtures are practice, not a disjoint transfer test.

`sage source remove ID` blocks future use while retaining the original and historical provenance. It is **not a privacy purge** and does not erase transcripts, historical responses or backups.

Privacy scope is local-only by explicit owner choice. `sage privacy purge --dry-run` previews the current whole-store ledger/blob/native-session purge; `--confirm` authorizes that scope. It is not selective lesson/source erasure. A copy-removal or SQLite checkpoint failure reports incomplete work, not success; close other Sage/database processes before retrying. Credentials, brain/cache/artifacts, original source files, backups, exports and provider/sync copies are retained. Older backups can restore removed data; SSD secure erasure is not guaranteed. Selective physical erasure is excluded from v2, not implemented or silently replaced with a wider purge.

Runtime compaction is manual-only by explicit owner choice: use the governed `/compact` path. Ordinary automatic compaction remains disabled and excluded from v2; refusal of an auxiliary summary is a disclosure guard, not automatic-compaction support.

## Maintenance

```sh
sage install npm:@scope/package@1.0.0 --trust
sage install "C:/my-extensions/helper.ts" --trust
sage list
sage remove npm:@scope/package
sage extensions
sage extensions disable "C:/my-extensions/helper.ts"
sage extensions enable "C:/my-extensions/helper.ts" --trust
sage config
sage update                  # Update Pi in Sage only
sage update --extensions --trust
sage doctor
sage status                  # --json gives a detailed context packet
sage evaluate                # Descriptive local outcomes, not causal efficacy
sage capabilities
sage artifact add drawing diagram.excalidraw TASK_INSTANCE_ID
sage artifact export ARTIFACT_ID graph.svg
sage brain show
sage brain edit              # Private home copy; Notepad by default on Windows
sage export private-records.json
sage backup learning-backup.json
sage plugin list
sage plugin add npm:@scope/package@1.0.0 --trust
sage plugin remove npm:@scope/package@1.0.0
sage plugin update --trust
sage pi info
sage pi update               # Sage's Pi, not global Pi
sage pi rollback
sage pi reset                # Retains installs/data
sage resource list
sage resource disable extensions "C:/path/extension.ts"
sage resource enable extensions "C:/path/extension.ts" --trust
sage theme list
sage theme set dark
```

Replace the example package/path with a real extension you have reviewed. For everyday customization stay inside the tutor: `/extensions list|add|enable|disable|remove PATH`, `/theme list|set NAME`, `/packages list|install|remove|update SOURCE`. Quote paths containing spaces. Executable extensions/packages require native OS-privilege trust confirmation; changed resources load with `/reload` or the next launch. These reuse Pi's settings/resource/package authority. The maintenance commands above remain compatibility helpers in the same `sage` launcher, with one scope: Sage's home. `sage uninstall` is an alias for remove; `--json` supports scripting. `sage --help` shows the short everyday interface; `sage help --all` includes recovery options. `/login`, `/model`, `/settings` and `/reload` remain Pi's native terminal controls.

Pi packages retain native npm/git/local sources, manifests and resource filters. Versioned npm packages stay pinned; use an unversioned source for tracking updates, or add the new version explicitly. Package removal uses native Pi semantics: managed package files are removed; local source files are retained. Individual extensions, skills, prompts and themes can be added, removed from configuration, enabled or disabled. `/settings` and `/reload` remain native Pi controls. See [Pi customization and updates](docs/PI.md) for examples and safety boundaries.

`sage pi update [latest|1.x.y]` installs a separate SDK, checks actual offline tutor startup, then atomically selects it for subsequent launches. Failed checks leave the previous selection active. Auth, learning records and installed customization packages are not overwritten. Unsupported major releases require an adapter update; updating global Pi has no effect on Sage. Development dependency updates can also use `bun update @earendil-works/pi-coding-agent`, followed by the checks below.

Files are created without overwriting existing outputs. Backups include a WAL-consistent database snapshot, verified originals and `brain.md`; they exclude credentials and Pi transcripts. Restore requires a **fresh** home:

```powershell
$env:SAGE_HOME = 'C:/path/restored-sage'
sage restore learning-backup.json
```

Restore checks hashes, schema version, tables and SQLite integrity before publishing the database. Backups are unencrypted; restore is limited to 200 MB. If a crash leaves `tutor.lock` or `pi-runtime/update.lock`, inspect the recorded PID and verify it has exited before removing that exact file. `doctor` reports the actual Pi version and checks resource errors, database/foreign keys, original hashes and auth-file presence without printing secrets. Missing configured packages may be installed by Pi's resource loader; `doctor` is not a strictly network-free check. Auth-file presence does not prove provider access.

## Verify

```sh
bun run typecheck
bun run lint
bun test
bun run smoke
```

Tests also cover profile/toggle parameters, planner-off intake, on-demand UI skill loading, quote/review/display/override gates, same-server browser capture/idempotency, bounded compilation/registry and trusted shell controls. Real Chrome QA additionally checked official rendering, bindings, local actions, default-off/opt-in, response-only capture and cancellation. These do not replace credentialed provider or learning-outcome checks. Tests cover actual Pi SDK startup/isolation, extension execution and native package removal, standalone/packaged resource switches, theme persistence, runtime update/rollback/reset, failure recovery, response authenticity, duplicates/stale revisions, exact rubric references, assistance timing, late corrections, deterministic replay, delays, source quarantine/injection handling, authenticated IPC, CLI maintenance and WAL backup/restore. Provider-hook fixtures explicitly mark unobservable stream/retry/compaction completion as unknown. Live provider behavior and instructional quality require credentialed checks.

Before publishing a staged change, run `bun run check:publication`. It checks staged files for private runtime paths, user-home paths and common credential patterns without printing their contents. Session transcripts, learning databases, learner preferences, credentials, local settings and interim agent plans/drafts are excluded by `.gitignore`. This is a guardrail, not a guarantee that arbitrary text contains no secrets; review anything personal before adding it to Git.

Bounded arithmetic, local sampled SVG graphing, Excalidraw-file validation and provenance-bearing artifact import/export are implemented; these are not live external-app controls or automatic modality scoring. PDF/OCR and drill adapters do not establish universal input support, installed codecs, semantic grading truth or learning efficacy. Voice delivery, OS-sandboxed code execution, symbolic CAS, live Desmos/whiteboard control, vault synchronization, protected-bank administration, automatic large banks and learned scheduling remain unverified or deferred. See [learning engine](docs/LEARNING-ENGINE.md), [architecture](docs/ARCHITECTURE.md) and [implementation record](docs/IMPLEMENTATION.md).

## Notes and Request For Feedback

The backend and agent cycle was personally designed with AI-assisted prompt iteration. Software choices reflect iteration from earlier systems.

Feedback on the core learning functionality and agent loop is warmly welcome:
- How the current approach works for your study workflow
- Observations on MCQ, open-ended free response, Feynman inversion, and active recall integration
- Practical feedback on `brain.md` preference handling

Feel free to open an issue, discussion, or get in touch on GitHub.
