---
name: ui
description: Create a bounded Studio surface for approved necessary task interaction or explicitly approved supplementary use; prefer native teaching and feedback.
---
Prefer native/open-ended teaching, questions and feedback. Studio is not a default presentation layer. The native learner reviews necessity for the exact frozen task and surface and explains which required interaction the native view cannot reliably support. Matching approved surfaces may then open automatically; changed source/task/goal requires fresh review. Tables, calculators, multiple fields or JavaScript alone do not establish necessity. Supplementary activities and task-free previews require approval for each opening. Missing native UI, cancellation or stale scope cannot create a URL. Admission is workflow authorization, never learner work, reading, understanding or mastery. Custom-JavaScript opt-in remains a separate browser decision.

Load this skill and its design reference on demand with `render_ui({})` (or the native `/skill:ui` command), then call the same single `render_ui({source})` tool with this compact DSL. No general filesystem tool is enabled. First read the current goal/task: the host binds to its latest frozen reviewed instance and shows that pinned prompt/criteria separately. If none exists this is preview-only, not a learner evidence channel. Align the UI to that task; do not put solutions in an independent activity. Two spaces per level; optional page title; containers need children. No loops, expressions or HTML. See [design.md](design.md) before composing.

```text
page "Explain the integral"
  h1 "Why does substitution work?"
  text "Give your reasoning, not just the result."
  input answer "Your explanation"
  button "Check locally" -> check($answer)
  text $feedback
---js
export function check({ answer }, ui) {
  ui.feedback = answer.trim() ? "Now explain what changes under substitution." : "Try an explanation first.";
}
```

Grammar: optional `page ["title"]` header (standalone or indented children), `col`, `row`, `card`; `h1|h2|h3|text|math "literal"` or `$name`; `input name ["label"]`; `button "label" -> exportedAction(name, "literal", 1, true, null)` (`$name` also accepted). Common leading indentation is normalized. Strings use JSON quoting. Math is readable Unicode text, not TeX. Cards wrap multiple children in a Column. One primary generated action; use rows sparingly.

State names are identifiers, not paths/prototype keys; fields and referenced state default to empty strings. Optional `---js` starts a browser ES module. Exported actions receive `(context, ui)`; named bindings resolve current fields (`context.answer`), literal arguments use `context.argN` (zero-based argument position). `ui.feedback = "…"`, `ui.get("answer")`, `ui.set("feedback", "…")` update official A2UI state reactively. Source ≤32KB, ≤128 expanded components, nesting ≤12.

Custom JS is OFF on load. Only a learner's trusted outer-shell **Run custom code** click enables it after a visible warning. It runs in an opaque allow-scripts iframe, never Bun. Restrictive CSP blocks fetch/resources but is NOT a strict security sandbox: opted-in code may navigate its own iframe/transmit entered UI data or consume CPU. No filesystem, private service tokens, learning records or reliable external-network access. Do not request personal/secrets data. Declarative input/rendering and trusted send/cancel work without JS; opt-in retains entered state.

Browser feedback/scores are non-authoritative. The outer shell copies only declared input fields into a bounded editable raw response preview, not generated feedback/state outputs; one field is plain text, multiple fields are labeled JSON. Only its **Send response to Sage** control invokes the parent's raw learner-work callback. When a custom module is available, its opt-in/use and input authorship/help cannot be proven by the scorer; the host conservatively marks the attempt as possibly supported even if the learner leaves code off. Generated code cannot submit/cancel through messages. The parent owns consent, task review, scope, scoring and persistence. Preview-only UIs have no submission callback. Never invent learner work or treat generated feedback as evidence of mastery.
