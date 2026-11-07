# Grader calibration anchors (FINAL, owner-scored 2026-11-07)

**The owner scores are authoritative and live in `set.ts` (`ANCHORS`).** The "Proposed" numbers below were Claude's first drafts. They were 10–25 points too lenient on A2, A5, A7, A8 and A9, which is F1 showing up in the item author. Grading rules: criteria first (met / partly / not), deductions only on met criteria (precision −7, range 5–10; polish −1, total ≤4), and repeating an answer the stem gives earns nothing.

For each anchor, fill in **Your score** and adjust the flaws. Severity is `blocking` (wrong or missing idea; repair required), `precision` (imprecise wording a strict examiner would penalise; **deducts**), or `polish` (style; small or no deduction). My proposed numbers are there to react to. Overwrite them freely.

Also answer once, at the bottom: how many points a typical **precision** flaw and a typical **polish** flaw should cost.

---

### A1 · Integration by parts · explain_why
**Item:** Explain why integration by parts works, and how you choose *u*.
**Rubric:** (1) links it to the product rule; (2) states ∫u dv = uv − ∫v du; (3) gives a reason for the choice of *u* (the derivative simplifies).
**Response:** "It comes from the product rule backwards. ∫u dv = uv − ∫v du. You pick u to be the thing that gets simpler when you differentiate it, like a polynomial."
**Proposed:** 95 · no flaws
**Your score:** ___  · **Flaws:** ___

### A2 · Integration by parts · explain_why (precision)
Same item and rubric as A1.
**Response:** "It's the product rule but reversed. You do uv minus the integral of the other one. Pick u as whatever is easier."
**Proposed:** 70 · precision: "the integral of the other one" (doesn't say ∫v du); precision: "whatever is easier" (easier to *differentiate*? the criterion is that u′ simplifies)
**Your score:** ___  · **Flaws:** ___

### A3 · u-substitution · apply_problem with working
**Item:** Evaluate ∫ 2x·cos(x²) dx. Show your substitution.
**Response:** "Let u = x², du = 2x dx. So ∫cos(u) du = sin(u) = sin(x²)."
**Proposed:** 85 · precision: missing "+ C"
**Your score:** ___  · **Flaws:** ___

### A4 · Method choice · method_choice
**Item:** Which method would you use for ∫ x·eˣ dx, and why? Don't solve it.
**Response:** "Substitution, because there's an e^x."
**Proposed:** 10 · blocking: "Substitution" (by parts is the method; no inner function's derivative appears)
**Your score:** ___  · **Flaws:** ___

### A5 · Cellular respiration · free_recall
**Item:** Where in the cell does the electron transport chain happen, and what is the final electron acceptor?
**Response:** "In the mitochondria. Oxygen is the final acceptor."
**Proposed:** 85 · precision: "In the mitochondria" (the *inner mitochondrial membrane*)
**Your score:** ___  · **Flaws:** ___

### A6 · Cellular respiration · explain_why
**Item:** Explain why cyanide, which blocks complex IV, stops ATP production even though glycolysis can still run.
**Rubric:** (1) complex IV blocked → electrons can't reach O₂; (2) the chain stops, so no proton pumping and no gradient; (3) ATP synthase needs the gradient; (4) glycolysis gives only 2 ATP net, too little.
**Response:** "Cyanide stops the electrons getting to oxygen so the chain backs up. No protons get pumped so there's no gradient and ATP synthase can't make ATP. Glycolysis still makes some ATP but not enough."
**Proposed:** 92 · polish: "some ATP" could say 2 net
**Your score:** ___  · **Flaws:** ___

### A7 · Cellular respiration · find_the_error
**Item:** A student wrote: "The Krebs cycle produces most of the cell's ATP directly." Find and correct the error.
**Response:** "Wrong, the Krebs cycle makes most of the energy as NADH."
**Proposed:** 72 · precision: "most of the energy as NADH" (NADH and FADH₂, which carry electrons to the ETC); possibly blocking: it never says where most ATP *is* made (oxidative phosphorylation). Your call.
**Your score:** ___  · **Flaws:** ___

### A8 · History argument · free_response
**Item:** Argue whether the Treaty of Versailles was the main cause of the Second World War. Use at least two pieces of evidence.
**Rubric:** (1) clear claim; (2) ≥2 specific pieces of evidence; (3) addresses a counter-argument; (4) the conclusion follows from the evidence.
**Response:** "The Treaty was a major cause but not the only one. The war guilt clause and reparations created resentment that Hitler used. However the Great Depression was also key because it made extremist parties popular. Appeasement also let Hitler expand. So Versailles was a cause but the Depression was the trigger."
**Proposed:** 80 · precision: "the Depression was the trigger" (contradicts the earlier framing; trigger vs underlying cause unclear); polish: the evidence is named but not dated or specific (which reparations, the 1932 election)
**Your score:** ___  · **Flaws:** ___

### A9 · History argument · free_response (thin)
Same item as A8.
**Response:** "Yes because Germany was angry about the treaty and wanted revenge so they started the war."
**Proposed:** 25 · blocking: no specific evidence; blocking: no counter-argument; precision: "Germany was angry" (no actor or mechanism)
**Your score:** ___  · **Flaws:** ___

### A10 · Integration · explain_why (right answer, wrong reason)
**Item:** Why does ∫₋₁¹ x³ dx equal 0?
**Response:** "Because x³ is zero at x = 0, which is in the middle of the interval."
**Proposed:** 15 · blocking: the reason is wrong (it's odd symmetry: the areas cancel); the answer 0 alone earns little
**Your score:** ___  · **Flaws:** ___

---

**Deductions:** a typical precision flaw costs ___ points (proposed 5–10); a typical polish flaw costs ___ points (proposed 0–2).
