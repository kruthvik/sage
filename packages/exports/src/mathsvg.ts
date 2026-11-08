// PDF only: typeset TeX maths with MathJax (TeX → SVG, glyphs as vector paths, no browser, no fonts to embed) and turn the
// SVG into absolute path strings in points that pdf-lib's drawSvgPath can fill. Only the base and AMS packages are loaded,
// so \href, \html, \def and friends are errors, and any error falls back to linear Unicode text.
import { mathjax } from "@mathjax/src/js/mathjax.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import "@mathjax/src/js/input/tex/base/BaseConfiguration.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/util/asyncLoad/esm.js";
import { MathJaxNewcmFont } from "@mathjax/mathjax-newcm-font/js/svg.js";

export const MATH_LIMITS = { texChars: 1500, perDocument: 300, pathChars: 400_000 } as const;

/** A typeset expression in points: `paths` are SVG path strings with y pointing down from the box top. */
export interface MathBox { width: number; ascent: number; descent: number; paths: string[] }

type M = [number, number, number, number, number, number]; // SVG matrix(a b c d e f)
const mul = (p: M, q: M): M => [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3], p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]];
function parseTransform(t: string | undefined): M {
  let m: M = [1, 0, 0, 1, 0, 0];
  for (const [, fn, args] of (t ?? "").matchAll(/(translate|scale|matrix)\(([^)]*)\)/g)) {
    const n = args!.split(/[\s,]+/).filter(Boolean).map(Number);
    if (n.some(x => !Number.isFinite(x))) throw new Error("bad transform");
    m = mul(m, fn === "translate" ? [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0] : fn === "scale" ? [n[0]!, 0, 0, n[1] ?? n[0]!, 0, 0] : n as M);
  }
  if (/[a-z]+\(/.test((t ?? "").replace(/(translate|scale|matrix)\([^)]*\)/g, ""))) throw new Error("unsupported transform");
  return m;
}
const fmt = (v: number) => (Math.round(v * 100) / 100).toString();
/** Absolute M/L/C/Q/Z path (what MathJax emits) through matrix m. Anything else throws, which falls back to text. */
function transformPath(d: string, m: M): string {
  const out: string[] = [], toks = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const pt = (x: number, y: number) => `${fmt(m[0] * x + m[2] * y + m[4])} ${fmt(m[1] * x + m[3] * y + m[5])}`;
  let i = 0, cmd = "";
  const num = () => { const v = Number(toks[i++]); if (!Number.isFinite(v)) throw new Error("bad path"); return v; };
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i]!)) cmd = toks[i++]!;
    const arity = ({ M: 2, L: 2, C: 6, Q: 4, Z: 0 } as Record<string, number>)[cmd];
    if (arity === undefined) throw new Error(`unsupported path command ${cmd}`);
    if (!arity) { out.push("Z"); continue; }
    const xs: string[] = [];
    for (let k = 0; k < arity; k += 2) xs.push(pt(num(), num()));
    out.push(`${cmd} ${xs.join(" ")}`);
    if (cmd === "M") cmd = "L"; // implicit lineto after moveto
  }
  return out.join(" ");
}

/** Minimal walk of MathJax's own SVG output: <svg>, <g>, <path>, <rect>. Any other element (e.g. <text> from an error) → undefined. */
function svgToBox(svg: string, sizePt: number): MathBox | undefined {
  const vb = /viewBox="([-\d.\s]+)"/.exec(svg)?.[1]?.trim().split(/\s+/).map(Number);
  if (!vb || vb.length !== 4 || vb.some(x => !Number.isFinite(x))) return undefined;
  const [minX, minY, w, h] = vb as [number, number, number, number], k = sizePt / 1000; // MathJax units are 1/1000 em
  const stack: M[] = [[k, 0, 0, k, -minX * k, -minY * k]], paths: string[] = [];
  const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  for (const [tag, close, name] of svg.matchAll(/<(\/?)([a-zA-Z-]+)[^>]*?>/g) as unknown as Iterable<[string, string, string]>) {
    if (name === "mjx-container" || name === "svg") continue;
    if (close) { if (name === "g") stack.pop(); continue; }
    if (name === "g") { stack.push(mul(stack.at(-1)!, parseTransform(attr(tag, "transform")))); if (tag.endsWith("/>")) stack.pop(); continue; }
    const m = mul(stack.at(-1)!, parseTransform(attr(tag, "transform")));
    if (name === "path") { const d = attr(tag, "d"); if (d) paths.push(transformPath(d, m)); }
    else if (name === "rect") {
      if (attr(tag, "data-background")) return undefined; // error box
      const [x, y, rw, rh] = ["x", "y", "width", "height"].map(a => Number(attr(tag, a) ?? 0)) as [number, number, number, number];
      paths.push(transformPath(`M ${x} ${y} L ${x + rw} ${y} L ${x + rw} ${y + rh} L ${x} ${y + rh} Z`, m));
    } else return undefined;
  }
  if (paths.join("").length > MATH_LIMITS.pathChars) return undefined;
  return { width: w * k, ascent: -minY * k, descent: (h + minY) * k, paths };
}

let doc: ReturnType<typeof mathjax.document> | undefined, adaptor: ReturnType<typeof liteAdaptor> | undefined;
/** Typesets one TeX expression, or undefined (error, unsupported construct, over a bound) so the caller prints it as text. */
export async function typeset(tex: string, display: boolean, sizePt: number): Promise<MathBox | undefined> {
  if (!tex.trim() || tex.length > MATH_LIMITS.texChars) return undefined;
  if (!doc) {
    adaptor = liteAdaptor(); RegisterHTMLHandler(adaptor);
    doc = mathjax.document("", { InputJax: new TeX({ packages: ["base", "ams"], formatError: (_: unknown, err: Error) => { throw err; } }), OutputJax: new SVG({ fontData: MathJaxNewcmFont, fontCache: "none", linebreaks: { inline: false } }) });
  }
  try {
    const node = await mathjax.handleRetriesFor(() => doc!.convert(tex, { display }));
    const svg = adaptor!.outerHTML(node);
    return /data-mjx-error|<text/.test(svg) ? undefined : svgToBox(svg, sizePt);
  } catch { return undefined; }
}
