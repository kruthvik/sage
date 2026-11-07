# Small practice surfaces

Use the shared warm-paper / ink system, not per-activity styles. `design.css` implements light/dark semantic colors, typography, spacing and official basic-catalog `--a2ui-*` hooks. Favor whitespace, clear labels and one primary generated action. The trusted shell owns the separate send/cancel controls.

- One page, a descriptive heading, a short prompt and the smallest useful form.
- Columns are the default; rows hold only a few short items. Stack content for narrow screens rather than building wide grids.
- Cards separate genuinely distinct content, never a card inside every card. Group ordinary content with columns.
- Say what the learner should do in plain language. Inputs need visible, meaningful labels; feedback should name the next useful step.
- Use h1/h2/h3 semantically, text for prose, math for readable Unicode notation. No HTML, TeX engine, images, external resources or custom CSS knobs.
- Do not rely on color alone, timers, animations, tiny text or browser feedback as a grade.
- Keep generated content separate from trusted response-preview/send controls. Do not mimic Sage receipts or ask for secrets.

Prefer declarative content; JS is optional and OFF by default. The learner must explicitly use the trusted **Run custom code** control after reading its warning. Opaque iframe/CSP isolation is not strict containment: opted-in code can navigate its own frame/transmit entered data or consume CPU. There is no trustworthy navigation prohibition. Scores and feedback remain non-authoritative even after opt-in; parent-side review/scoring/persistence are separate.
