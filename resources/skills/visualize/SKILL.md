---
name: visualize
description: Use visuals automatically when useful or when the learner asks. Prefer native Pi text diagrams and bounded local plots; preserve current-task aids, source scope and native Continue.
---

# Visual explanations

Use a visual automatically when useful: a relationship, sequence, contrast, spatial arrangement or changing quantity is clearer than prose alone. Also offer one when the learner asks. Do not add a picture to every explanation, assume a visual learning style, or claim that engagement proves learning.

## Keep it native

1. Read `learning_context` for the current goal, lesson unit, task, frozen aids and selected source permissions. Use only currently authorized facts; old conversation text is not renewed source permission. Stay with the current task, not a future item.
2. For a process, hierarchy or contrast, use a small native Pi text diagram with short labels and an accompanying explanation. Give arrows explicit meanings. Keep labels readable on a narrow terminal. Describe the relationship in words as an accessible alternative; do not rely on color or alignment alone.
3. For a single explicit mathematical function, use the existing `learning_source` graph capability, not generated JavaScript or an invented renderer. Its bounded arithmetic grammar supports a single `y=f(x)` expression, with `x,y range [-10,10]`. Use a fresh operation ID, the current `expected_goal_revision_id`, and only a currently owned task instance if one is appropriate. Actual availability comes from `learning_source` capabilities, not this guide.
4. A successful graph may carry host-produced `native_preview: true`: Pi then displays a coarse sampled plot directly in the terminal without expanding tool details. The saved SVG stays unchanged. The preview adapts to terminal width; a very narrow terminal gives a widen-window message. Explain the axes, relevant feature and sampling limits. Discontinuities, fine structure and off-window behavior may be missed; this is not a symbolic proof.
5. The host withholds automatic previews in exam/cram/drill modes, stopped lessons and pending answer-bearing work. `native_preview: false` is not an invitation to echo the SVG, draw its answer elsewhere or open a browser. Do not manufacture this response field. During governed instruction, keep any aid consistent with the pinned unit and its sources. A graphic never advances the lesson or presses Continue.

## Protected current-instruction diagrams

When an approved learn/accelerate instruction benefits from a small relationship map, set `diagram: true` on its otherwise unchanged `learning_activity` teaching request. This is a native teaching-only option, not approval or permission to Continue. It adds one bounded request using the selected parent model, with no tools or ambient resources. The helper receives only that current instruction, never its question/answer key, journals or arbitrary caller text. The native display combines the original instruction and a labeled AI aid; the learner still chooses Continue or Not now. Omit the flag when it adds no value or cost is unwarranted.

For a diagram requested while a governed unit is paused before its question, `learning_source` also accepts `action: "drawing"`, a stable `operation_id`, the current `expected_goal_revision_id` and `artifact_revision_id` of that unit's instruction, with `input` omitted. Do not combine this reference route with raw input. Existing drawing with `input` remains the local Excalidraw adapter, not this child. Successful same-operation replays reuse the saved diagram instead of another model request.

The child proposes two to six nodes and one to eight labeled directed relationships with exact supporting instruction quotes. A native text map and structured JSON artifact are not an SVG/Mermaid renderer or an observed image. Quote checks bind provenance but do not establish correct meaning. Label the aid as AI-generated and unverified; if a useful proposal is unavailable, retain the original native explanation instead of inventing data or opening a browser. No new unit selection, question release, learner work or assessment is created by the aid. Source artifact reads of these aids also stop once their question is pending.

## Preserve evidence and aid controls

Tutor-created plots and diagrams are explanatory aids, not learner performance, grades or independent demonstrations. Existing capability calls already retain immutable artifact and possible-assistance receipts; do not replace them with new scoring rules. A picture that reveals a method or answer can contaminate an attempt even if the learner requested it.

Do not add a solved diagram during a pending independent question whose frozen aids exclude it. Use existing learner-controlled help/assistance handling or wait for feedback; do not silently change conditions, erase assistance, reuse exposed work as an independent recheck, or mark success from the graphic. Use the current quiz, explanation, drill and review controls for retrieval checks, not a parallel quiz/scoring engine. Assess actual fresh learner work against the pinned criterion.

Attribute source-based facts to accepted selected spans when available. Label generated interpretations and uncertainty. Model-drawn relationships are not verified observations, graph validation checks arithmetic/geometry rather than educational truth, and images alone do not establish practical or physical performance.

## Escalate only for an actual need

Use a browser only when the required interaction or figure genuinely cannot be conveyed natively. The existing `render_ui` flow still requires exact native learner approval; a model preference, prettier layout or multiple inputs does not prove necessity. If a needed image/renderer is unavailable, say so and offer an honest text alternative instead of claiming it rendered.

No arbitrary SVG, Mermaid, HTML or JavaScript execution, package downloads, external fetches, vault writes or new child permissions are granted here. General SVG/Mermaid makers and research roles are separate protected-helper work, not installed by this guide. Never substitute a third-party subagent extension or bypass disclosure/cancellation safeguards.
