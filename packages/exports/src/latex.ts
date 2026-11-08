// PDF only: common LaTeX maths → Unicode, so "$\frac{1}{4} \le x^2$" prints as "1/4 ≤ x²" instead of raw markup.
// The Markdown export keeps the exact text (Obsidian renders LaTeX itself). Dollar amounts ("$500") are left alone:
// a $…$ span is treated as maths only when it contains a backslash command, ^, _ or braces.

const SYM: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", equiv: "≡", sim: "∼", propto: "∝", ll: "≪", gg: "≫",
  times: "×", cdot: "⋅", div: "÷", pm: "±", mp: "∓", ast: "∗", circ: "∘", degree: "°", prime: "′",
  infty: "∞", partial: "∂", nabla: "∇", int: "∫", iint: "∬", oint: "∮", sum: "∑", prod: "∏",
  to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔", Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔", implies: "⇒", iff: "⇔", mapsto: "↦",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇", cup: "∪", cap: "∩", emptyset: "∅", varnothing: "∅",
  forall: "∀", exists: "∃", neg: "¬", land: "∧", lor: "∨", wedge: "∧", vee: "∨", therefore: "∴", because: "∵",
  ldots: "…", cdots: "⋯", dots: "…", angle: "∠", perp: "⊥", parallel: "∥", triangle: "△", hbar: "ℏ", ell: "ℓ",
  "{": "{", "}": "}", "%": "%", "$": "$", "&": "&", "#": "#", "_": "_",
  ",": " ", ";": " ", ":": " ", "!": "", quad: "  ", qquad: "    ", " ": " ",
};
const FUNCS = new Set("sin cos tan sec csc cot arcsin arccos arctan sinh cosh tanh log ln exp lim max min det gcd mod".split(" "));
const SUP: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", x: "ˣ", y: "ʸ", a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", k: "ᵏ", m: "ᵐ", t: "ᵗ", T: "ᵀ", "−": "⁻" };
const SUB: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", a: "ₐ", e: "ₑ", i: "ᵢ", j: "ⱼ", k: "ₖ", n: "ₙ", o: "ₒ", r: "ᵣ", t: "ₜ", x: "ₓ", "−": "₋" };

const ARG = String.raw`\{([^{}]*)\}`; // innermost brace group; applied repeatedly so nesting resolves from the inside out
const simple = (s: string) => /^[\p{L}\p{N}.′]+$/u.test(s) || /^[\p{L}\p{N}][\p{L}\p{N}.]*[²³¹⁰-⁹]*$/u.test(s);
const wrap = (s: string) => simple(s) ? s : `(${s})`;
const script = (body: string, map: Record<string, string>, mark: string) => {
  const chars = Array.from(body);
  return chars.length && chars.every(c => map[c]) ? chars.map(c => map[c]).join("") : `${mark}${wrap(body)}`;
};

/** Converts one maths expression (no delimiters). `subscripts`: only inside real maths, since "_" in prose is usually an identifier. */
function mathToUnicode(m: string, subscripts: boolean): string {
  let s = m.replace(/\\(?:left|right|big|Big|bigg|Bigg)(?![a-zA-Z])\s*([()[\]|.]|\\[{}])?/g, (_, d: string | undefined) => d === "." || !d ? "" : d.replace("\\", ""));
  s = s.replace(new RegExp(String.raw`\\(?:text|mathrm|mathbf|mathit|mathsf|operatorname|textbf|textit)\s*${ARG}`, "g"), "$1");
  for (let i = 0; i < 6; i++) {
    const before = s;
    s = s.replace(new RegExp(String.raw`\\[dt]?frac\s*${ARG}\s*${ARG}`, "g"), (_, a: string, b: string) => `${wrap(a.trim())}/${wrap(b.trim())}`)
      .replace(new RegExp(String.raw`\\sqrt\s*\[([^\]]*)\]\s*${ARG}`, "g"), (_, n: string, x: string) => `${n === "3" ? "∛" : n === "4" ? "∜" : `${script(n, SUP, "^")}√`}${wrap(x.trim())}`)
      .replace(new RegExp(String.raw`\\sqrt\s*${ARG}`, "g"), (_, x: string) => `√${wrap(x.trim())}`)
      .replace(new RegExp(String.raw`\^\s*${ARG}`, "g"), (_, x: string) => script(x.trim(), SUP, "^"))
      .replace(new RegExp(String.raw`_\s*${ARG}`, "g"), (_, x: string) => subscripts ? script(x.trim(), SUB, "_") : `_${x}`);
    if (s === before) break;
  }
  s = s.replace(/\\sqrt\s*([\p{L}\p{N}])/gu, "√$1")
    .replace(/\^([\p{N}]|[a-zA-Z](?![a-zA-Z]))/gu, (_, c: string) => script(c, SUP, "^"));
  if (subscripts) s = s.replace(/_([\p{N}]|[a-zA-Z](?![a-zA-Z]))/gu, (_, c: string) => script(c, SUB, "_"));
  s = s.replace(/\\([a-zA-Z]+|[{}%$&#_,;:! ])/g, (whole, name: string) => SYM[name] ?? (FUNCS.has(name) ? name : whole));
  return subscripts ? s.replace(/(?<!\\)[{}]/g, "") : s;
}

export { mathToUnicode };
export interface MathSpan { tex: string; display: boolean }
const isMath = (x: string) => /\\[a-zA-Z]|[\^_{]/.test(x);
const DELIM = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\p{N}])\$([^$\n]+?)\$(?!\p{N})/gu;

/** Splits prose into text and delimited maths ($$…$$ and \[…\] are display; \(…\) and $…$ inline). A $…$ pair is maths only when
 * it holds a command, ^, _ or braces, so "$500 and $200" stays text; the scan then resumes one character on, so a dollar amount
 * can't swallow the opening $ of real maths later in the line. */
export function splitMath(text: string): (string | MathSpan)[] {
  const out: (string | MathSpan)[] = []; let last = 0, m: RegExpExecArray | null;
  DELIM.lastIndex = 0;
  while ((m = DELIM.exec(text))) {
    const inline = m[4];
    if (inline !== undefined && !isMath(inline)) { DELIM.lastIndex = m.index + 1; continue; }
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ tex: (m[1] ?? m[2] ?? m[3] ?? inline!).trim(), display: m[1] !== undefined || m[2] !== undefined });
    last = DELIM.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// A bare command counts as maths only when it isn't glued to a path or word: "x \to y" converts, "C:\pi" and "notes\to" don't.
const BARE = String.raw`(?<![\p{L}\p{N}_:.\\/~-])`;
/** Undelimited prose: models often skip the $, so known commands and x^2 still convert; anything else is left alone. */
export function bareToUnicode(text: string): string {
  return text
    .replace(new RegExp(String.raw`${BARE}\\(?:[dt]?frac|sqrt)\b[^\n]*`, "gu"), seg => mathToUnicode(seg, false))
    .replace(new RegExp(String.raw`${BARE}\\([a-zA-Z]+)(?![a-zA-Z])`, "gu"), (whole, name: string) => SYM[name] ?? whole)
    .replace(/(?<=[\p{L}\p{N})])\^(\{[^{}\n]*\}|[\p{N}]+|[a-zA-Z](?![a-zA-Z]))/gu, (_, x: string) => script(x.replace(/^\{|\}$/g, ""), SUP, "^"));
}

/** Text of one PDF block → text with LaTeX maths shown as Unicode (the linear fallback when typesetting is unavailable). */
export function latexToUnicode(text: string): string {
  return splitMath(text).map(p => typeof p === "string" ? bareToUnicode(p) : mathToUnicode(p.tex, true)).join("");
}
