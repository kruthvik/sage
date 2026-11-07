# Pi customization and updates

Sage embeds Pi's public SDK and native terminal. It does not fork Pi, invoke a globally installed executable, or copy global credentials. Pi is a normal dependency; the checked-in lockfile currently resolves 1.0.0. Sage supports Pi 1.x and checks the actual tutor adapter before activating a separately installed version.

## One launcher and in-session customization

Launch `sage` (or `bun run dev`). Everyday controls are native tutor commands: `/sage` opens a learning preview, `/extensions list|add|enable|disable|remove PATH`, `/theme list|set NAME`, and `/packages list|install|remove|update SOURCE` customize the isolated Pi home. Quote paths containing spaces. Adding/enabling executable code requires native trust confirmation. Use `/reload` or restart for resource changes; `/theme set NAME` also requests the current terminal theme. The commands below remain maintenance/compatibility helpers, not a second application.

## Update the engine independently

```sh
sage pi info
sage pi update              # Latest compatible Pi 1.x
sage pi update 1.0.0         # Explicit reproducible selection
sage pi rollback
sage pi reset               # Installed copies remain
```

Updates go under `SAGE_HOME/pi-runtime/install-UUID/`, never into a global npm/Bun installation. The candidate is installed with lifecycle scripts disabled, checked against required public exports, and started with the actual seven-tool tutor adapter in an empty probe home without credentials or provider calls. Only a successful check publishes `active.json`, using an atomic rename. Failed candidates and older installs are retained for diagnosis and recovery. Unsupported major versions are rejected rather than silently assumed compatible.

Updates affect the next tutor launch. A running tutor keeps its current SDK. The first isolated update has no previous isolated installation: use reset to return to bundled Pi. Subsequent updates support rollback. A stale `update.lock` requires checking that its recorded PID has exited before removing that exact lock. Custom extensions may need their own compatibility fixes even when core startup passes.

For development, `bun update @earendil-works/pi-coding-agent` updates the bundled dependency within its declared range. Run lint, tests and smoke afterward. If an isolated SDK is selected, it takes precedence until reset or another isolated update.

## Reuse an installed Pi engine

```sh
sage pi share "C:/Pi/releases/1.3.0" --trust
sage pi info
sage pi rollback
sage pi reset
```

The example path is a placeholder. Supply an existing versioned installation root whose directory name equals its Pi version and which contains `node_modules/@earendil-works/pi-coding-agent`. Sage does not download, copy, update or modify that installation. It stores a fingerprinted reference under its own `pi-runtime/install-UUID/` and runs the same empty-home tutor compatibility check before activation. Only engine code is shared—not global settings, credentials, prompts or extension registrations.

The engine and its installed dependency tree are checked before each load. Changed code, missing files, links outside the versioned installation, malformed references and trees above 50,000 files or 1 GiB are refused. Verification now overlaps at most two file opens, retains the original byte-for-byte fingerprint order, and closes pending handles on failure. `pi info` performs one full scan instead of two; no metadata-only cache skips content checks. In local measurements, a first pass took about 50 seconds versus an earlier serial 105-second pass, while counterbalanced warm scans varied around 4–8 seconds. OS caches and external I/O load were not controlled, so these are observations, not a startup-time guarantee. Scans can still delay startup substantially; sharing is not activated automatically. Failed adoption leaves the previous selection unchanged. If an already-selected installation later changes or disappears, startup fails closed: use `sage pi rollback` for a verified previous selection or `sage pi reset` for bundled Pi. Recovery is explicit, not an automatic downgrade.

Selection applies on the next tutor launch, never through `/reload`. A newer global Pi version is not silently adopted; select its new versioned root explicitly. Keep old selected roots intact for rollback. Fingerprints detect changes relative to the trusted installation; they are not publisher signatures, an OS sandbox or protection against a privileged process racing the loader. Startup compatibility checks do not prove every feature or real terminal behavior on another Pi version.

Sage uses its existing protected Pi SDK child engine for the approved narrow-helper route. The full `pi-subagents` extension remains disabled and deferred; its workflow/background-run features have not been integrated. Engine sharing does not enable it or any other extension.

Protected children use a fixed policy/operation pair and pin the parent session and disclosure revision before preparation. They recheck that scope at dispatch, payload authorization and before returning a proposal. A scope change, foreign parent or disabled sharing is refused; an old-scope reply is discarded. Requests are frozen as JSON before asynchronous setup, with a 32,768-character prompt limit. Returned text must be nonempty and at most 32,768 characters; caller-specific schemas and publication checks still apply.

Each child has no ambient extensions, skills, context files, themes or tools, uses an in-memory session, and is limited to one model request with a requested output maximum of 4,096 tokens. Abort/timeout propagation is retained, and disposal still runs if SDK abort fails. The timeout relies on cooperative SDK/provider cancellation; it is not an OS sandbox or a guarantee that arbitrary stalled I/O stops immediately. The returned-text check is not a hard network-stream memory cap.

Trusted callers must build requests from current owned, authorized facts and validate the resulting proposal before using it. The child engine is not a sanitizer for arbitrary caller-supplied text, and AI proposals are never learner performance. Dedicated visual/research roles and their learner controls are separate learning-feature work, not already enabled by this engine change.

## Native visual explanations

The selected `visualize` skill guides the tutor to use visuals when they clarify a lesson or when you request one. Prefer native text diagrams for relationships and the existing local graph capability for a single mathematical function. Visual choice and explanatory quality still depend on the model; this is not an efficacy claim or a guarantee that it chooses a good diagram.

Eligible tutor-created graphs now show an ASCII sampled preview inside Pi without expanding tool details. They need no browser, image-terminal protocol or new renderer. The saved SVG, artifact authorship and assistance receipts stay unchanged; expand tool details to inspect the original response. The preview resizes to the terminal, uses a fixed `x,y` window of `[-10,10]`, and may miss discontinuities or fine detail. A narrow window asks you to widen it. It is an explanatory aid, not learner performance or symbolic proof.

The host computes the preview hint for each graph response, including retries. Automatic previews stay off for stopped lessons, exam/cram/drill modes and pending answer-bearing work. Governed instruction can include a preview while waiting for Continue, without releasing its question. This is a response-time display hint, not a permission grant or semantic proof that an aid is appropriate; old displayed history is not erased. Keep the existing frozen-aid, source, explicit-help and fresh-independent-recheck rules.

A browser remains a fallback only for a required interaction that native Pi cannot support, through the existing native approval flow. No arbitrary SVG/Mermaid/JavaScript execution, raster renderer, new protected maker/research role or journal write-back is enabled by this slice. Existing quiz, explanation, drill and review controls are reused.

## Protected instruction-diagram helper

Ask for a diagram during a guided learn/accelerate lesson. The tutor can request a small AI relationship map when useful or on request, alongside the approved instruction in native Pi. No plugin, browser, image-terminal protocol or renderer install is needed. This is a bounded node-and-arrow text diagram, not general SVG/Mermaid rendering or a verified picture.

For normal teaching, the existing `learning_activity` request accepts a native-only `diagram: true` option. The original core request is still validated after stripping this option. It adds one protected child request using the selected parent model: no tools/ambient resources, at most one request and a requested 4,096-token output limit. Only the current owned instruction is supplied—not journals, history, the question/answer key or arbitrary model-provided text. Omit the option when a diagram adds no value. Model choice and diagram meaning remain unverified, not teaching efficacy.

The native display keeps Continue and Not now separate from the aid. Preparing an artifact changes the state revision, so Sage obtains a fresh pinned instruction offer before the learner can Continue; it never reuses that older continuation lease. “Not now” keeps the question unreleased. Results report `diagram_offered` and, when available, its artifact ID: an offer is not reading, understanding or learner performance. An unavailable proposal leaves the original instruction workflow intact.

For a paused governed unit before question release, `learning_source` also supports `action: "drawing"` with stable operation/goal pins and `artifact_revision_id` of its current instruction, omitting `input`. Existing drawing with `input` remains the local Excalidraw adapter; do not combine the two. Current sharing, accepted-source, unit, mode and cancellation checks apply. A successful same-operation replay uses the saved artifact without another model request. Old diagram reads cannot bypass a newly pending question.

Proposals have 2–6 nodes and 1–8 labeled edges, valid references and exact supporting quotes in the instruction. Quote matching is lexical provenance, not proof that a relationship is correct. Output is an attributed `instruction_diagram` JSON artifact with an inert managed Markdown copy. For a separate structured export:

```sh
sage artifact export ARTIFACT_ID diagram.json
```

Plain JSON export contains the proposal, not its full managed receipt. No scores, learner responses, automatic question release or changed rubrics are created. Rich SVG/Mermaid rendering, research roles, live-model quality and real terminal review remain separate work.

## Optional private study journal

Use `/journal` in an idle native session to write a note for the current goal, review its complete preview and confirm saving. Nothing is logged automatically. Notes stay out of chat/model messages and are never submitted as answers or assessed work. This first version accepts manually entered or pasted reflections, not automatic AI summaries. The note limit is 12,000 characters; the compiled document also has a 24,000-character bound.

Sage adds bounded goal/source-reference metadata and references to actual recorded attempts, not source excerpts, transcripts, answers or invented mastery. The document is a host-compiled container; entered text and outside assistance remain unverified. Originals use the existing immutable artifact store and normal educational backups. Private content therefore exists in those backups too: protect them. Managed, attributed Markdown copies live under `SAGE_HOME/content/…/study_journal/`. Existing edited files are never overwritten; a blocked copy leaves the original safely recorded and reports how to retry explicit export.

The native command checks conversation/goal scope and confirmation. If saving is rejected, it reopens the unsaved text locally for copying rather than placing it in the chat editor. If a notification fails after commit, the original is still saved; do not save it again merely because a notice failed. Model tools cannot create or read `study_journal` artifacts. To use a note with a model, explicitly import, preview, accept and select it as a source under the usual sharing controls. Executable extensions and external sync software still have their own OS-level access; this is not a sandbox.

Optional exports reuse the existing explicit, non-overwriting commands. Use the artifact ID from the save notice; a vault must be configured separately:

```sh
sage artifact export ARTIFACT_ID new-note.md
sage vault export ARTIFACT_ID journal/new-note.md
```

Real terminal readability and learning benefit are separate acceptance checks, not established by software tests.

## Automatic research and source review

Sage reuses [pi-web-access](https://github.com/nicobailon/pi-web-access), not a separate search backend. Install a reviewed version in Sage and configure its provider using the extension's instructions. Sage does not copy global Pi credentials:

```sh
sage install npm:pi-web-access@0.42.0 --trust
```

Native learn/accelerate setup keeps already-selected accepted sources. It does not silently share the whole library. Confirm the displayed public topic once to let the extension search automatically; private excerpts, journals, answers and background notes are not added to the query. Headless, sharing-off and other modes do not start this workflow.

Sage checks up to five results and retrieves readable text through the extension. The review list excludes known library URLs and exact-content duplicates, including learner-added copies. This is not semantic duplicate detection across differently formatted PDFs or editions. Review each new source's complete preview, then accept/use or decline it. Only accepted sources join the lesson; unreviewed results are not admitted or selected. Acceptance is permission to use an external source, not a truth or authorship guarantee.

Each preview is limited to 18,000 text characters. Longer or unsupported results are skipped, not silently shortened into a supposedly complete source. A missing or failed provider leaves existing lesson sources usable. Sage launches no background agent or separate research-model child; the extension's configured providers can have their own requests and charges. These extension tools are kept off the model-direct route; native setup performs the bounded calls and source review. Other installed extensions retain their normal privileges.

Accepted copies use the existing immutable source store, normal source backups and Sage cache. Rejection prevents admission/use; it does not erase the extension's cache or session data. Extension code has OS privileges, not a sandbox. Live-provider configuration and actual terminal review still need operator checks; the package was exercised with scripted search/page responses, not live-model or efficacy validation.

## Native Pi packages

```sh
sage install npm:@example/pi-tools@1.0.0 --trust
sage install git:github.com/example/pi-tools@v1 --trust
sage install ./local-package --trust
sage install ./helper.ts --trust
sage list
sage remove ./local-package
sage update                          # Isolated Pi SDK
sage update --extensions --trust      # Native Pi packages
sage update npm:@example/pi-tools --trust
```

These are the familiar [Pi command-line verbs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md), adapted to one isolated Sage scope and an explicit trust acknowledgement. `uninstall` aliases `remove`. `sage --version` reports the selected SDK. Customization commands accept `--json`; the existing `plugin` and `resource` commands remain compatible. `--local` and `--global` are rejected, not forwarded to a global Pi instance. `sage update` does not also update executable packages; that requires the explicit package command above.

Examples use placeholder package names; choose a real package you have reviewed. npm/git sources use Pi's native syntax, manifests, dependency installation and filters. Relative local sources are resolved from the invocation directory for both add and remove. Local packages are referenced, not copied or deleted. Managed npm/git package removal uses native Pi removal. Unversioned npm sources can track updates; pinned npm versions do not advance automatically. Add an explicit new version to change a pin. Git updates reconcile the configured ref, without moving a tag or commit to a different ref.

Packages can supply extensions, commands, skills, prompts and themes together. Installed extension tools generally work alongside the seven educational tools; pi-web-access discovery tools use the native research/source-review route described above. Built-in coding tools such as read/bash/edit/write are disabled in tutor sessions. Pi CLI-only built-in extensions are not automatically injected into this SDK host; reviewed packages can provide additional capabilities.

Sage ensures configured npm packages have managed copies in `agent/npm/node_modules/` before discovery or reload, rather than accepting Pi's legacy global npm fallback. Explicitly configured local paths can intentionally reference resources elsewhere. Isolation protects configuration ownership; it is not a filesystem or network sandbox. Third-party extension code and installation scripts have OS privileges and can access local files or send data externally. `--trust` acknowledges that boundary.

## Individual resources

```sh
sage extensions
sage extensions add ./helper.ts --trust
sage extensions disable ./helper.ts
sage extensions enable ./helper.ts --trust
sage extensions remove ./helper.ts
sage config
sage resource list
sage resource add extensions "C:/my-resources/helper.ts" --trust
sage resource add skills "C:/my-resources/study-skill"
sage resource add prompts "C:/my-resources/review.md"
sage resource add themes "C:/my-resources/custom.json"
sage resource disable extensions "C:/my-resources/helper.ts"
sage resource enable extensions "C:/my-resources/helper.ts" --trust
sage resource remove prompts "C:/my-resources/review.md"
```

Kinds are `extensions`, `skills`, `prompts` and `themes`. Use paths shown by resource list for individual packaged resources. Enable/disable writes Pi's own resource switches and package-specific filters, preserving other settings. Remove unregisters a top-level path without deleting its files. An auto-discovered resource can still load after unregistering its path: disable it to turn it off. Adding/enabling executable extensions requires `--trust`.

Pi's direct-file package loader does not honor package resource filters. Switching a directly installed file migrates that one registration to Pi's native standalone path/switch settings, without moving or deleting the file. It then appears through `sage extensions` when enabled rather than `sage list` (which lists packages). `sage remove PATH` also unregisters that standalone path. Explicit external resources retain a discovery path alongside their switch so disabling and re-enabling them actually works.

Standard auto-discovery directories live under `SAGE_HOME/agent/`. Native resource edits take effect on the next launch or `/reload`. Sage's inline learning tools and packaged tutor policy are application infrastructure, not removable customization packages.

## Themes and other settings

```sh
sage theme list
sage theme set dark
sage theme set light
sage theme set system
sage theme set MY_INSTALLED_THEME
```

Custom themes can be installed through packages or resource paths. Selection is validated against successfully loaded themes and saved to Sage's native `agent/settings.json`. `/settings` changes the current terminal; CLI selection applies on the next launch. Native Pi theme syntax and validation remain authoritative.

Pi also owns `/login`, `/model`, `/settings`, `/reload`, session navigation and its other normal terminal controls. Advanced settings can be edited in `SAGE_HOME/agent/settings.json` using Pi's documented schema, including filtered package objects. Keybindings belong in `agent/keybindings.json` and custom model/provider definitions in `agent/models.json`. The CLI overrides `PI_CODING_AGENT_DIR` only in its own process, so terminal helpers use the same isolated root as the SDK.

Global Pi settings, authentication, packages and themes remain untouched by Sage's own operations. Invocation `.pi` context/resources are not auto-loaded. Shared `~/.agents/skills` are excluded by default; a literal skill/package path explicitly registered in Sage settings opts into sharing. Provider environment variables are still honored by Pi.

The planning subagent is another short-lived session of the same selected Pi SDK, not a separate global Pi process or model service. It reuses the selected provider/auth runtime (including registered provider integrations) but loads none of the tutor's user extensions, tools, themes or ambient instructions. When the learner's planner feature is enabled, a child plan adds one model request at intake or consequential replanning; it does not run after every answer. Both tutor and planner benefit from Sage's isolated Pi updates.

The v2 learning engine retains the four original educational tool names and adds `learning_activity` for MCQ selection, a curious-novice Feynman child, and prompted image scrap work. The current tutor additionally exposes one `render_ui` tool. Call it with `{}` for on-demand DSL/design instructions or `{source}` for an official A2UI browser activity on the existing local server. It does not enable a general read tool or execute generated code on Bun; custom browser code is off until explicit outer-shell opt-in and is not a strict security sandbox. Both child roles use the selected isolated Pi runtime. Context includes compact component dimensions, hypotheses, review offers and deterministic candidate features for Pi to interpret. `learning_source` also discovers capabilities and provides bounded local calculation/graph/drawing artifacts. It does not grant arbitrary network/code access or turn tutor artifacts into learner evidence. See [Learning engine v2](LEARNING-ENGINE.md) and [Interactive activities](ACTIVITIES.md) for current behavior and limits.

`sage doctor` shows the selected version, paths, resource diagnostics and learning-store integrity without reading credentials into its output. Resource inspection can execute configured extensions and install missing configured packages through Pi; it is not a sandboxed or strictly offline check. Educational backups exclude Pi credentials, transcripts, settings, packages and runtime installations; back those up separately if needed.
