// PDF-only LaTeX → Unicode (the Markdown export keeps the exact source).
import { expect, test } from "bun:test";
import { latexToUnicode as L } from "../src/latex.ts";

test("common maths LaTeX prints as Unicode", () => {
  expect(L(String.raw`$\frac{1}{4} \le x^2$`)).toBe("1/4 ≤ x²");
  expect(L(String.raw`The area is $\int_0^1 x^2\,dx = \frac{1}{3}$.`)).toBe("The area is ∫₀¹ x² dx = 1/3.");
  expect(L(String.raw`$$\sqrt{b^2-4ac}$$`)).toBe("√(b²-4ac)");
  expect(L(String.raw`\(\alpha + \beta \neq \gamma\)`)).toBe("α + β ≠ γ");
  expect(L(String.raw`use \frac{a+b}{2} here; x = -1 \pm 3`)).toBe("use (a+b)/2 here; x = -1 ± 3");
  expect(L(String.raw`$x_{n+1} = x_n$ and $\sqrt[3]{27} = 3$`)).toBe("xₙ₊₁ = xₙ and ∛27 = 3");
  expect(L(String.raw`$\frac{\frac{1}{2}}{3}$`)).toBe("(1/2)/3");
});

test("prose is left alone: dollar amounts, paths, identifiers", () => {
  for (const s of ["costs $500 and $200", String.raw`C:\Users\kruth\notes`, "node_check and a_b", "Assets = Liabilities + Equity, $5,000 = $0 + $5,000"]) expect(L(s)).toBe(s);
});
