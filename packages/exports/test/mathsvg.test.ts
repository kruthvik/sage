// PDF maths: MathJax typesets TeX into vector paths; anything it can't (or shouldn't) render comes back undefined.
import { expect, test } from "bun:test";
import { MATH_LIMITS, typeset } from "../src/mathsvg.ts";

test("fractions, roots, matrices and big operators typeset as filled paths with real layout", async () => {
  const frac = (await typeset(String.raw`x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}`, false, 11))!;
  expect(frac.paths.length).toBeGreaterThan(10);
  expect(frac.ascent).toBeGreaterThan(8); expect(frac.descent).toBeGreaterThan(3); // stacked: above and below the baseline
  const m = (await typeset(String.raw`\begin{pmatrix} a & b \\ c & d \end{pmatrix}`, true, 11))!;
  expect(m.ascent + m.descent).toBeGreaterThan(20); // two rows tall
  const inline = (await typeset("ax^2+bx+c=0", false, 11))!; // one box, not split at break points
  expect(inline.width).toBeGreaterThan(40);
  for (const b of [frac, m, inline]) for (const p of b.paths) expect(p).toMatch(/^M [-\d. ]+(?: [MLCQZ](?: [-\d.]+ [-\d.]+)*)*$/);
  expect(await typeset(String.raw`\sum_{n=1}^\infty \frac{1}{n^2} = \frac{\pi^2}{6}`, true, 14)).toBeDefined();
});

test("unsupported, unsafe or oversized input is not typeset (the caller prints text)", async () => {
  for (const tex of [String.raw`\href{http://example.invalid}{click}`, String.raw`\def\a{\a\a}\a`, String.raw`\frac{1}{`, "", "x".repeat(MATH_LIMITS.texChars + 1)])
    expect(await typeset(tex, false, 11)).toBeUndefined();
});
