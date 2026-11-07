import { expect, test } from "bun:test";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import { presentationRenderers, CompactTextComponent, formatCompactCall, formatCompactResult, nativeToolPresentation } from "../src/presentation.ts";

test("CompactTextComponent renders array of lines for terminal", () => {
  const c = new CompactTextComponent(["Line 1", "Line 2"]);
  expect(c.render(80)).toEqual(["Line 1", "Line 2"]);
});

test("formatCompactCall produces concise tool execution header", () => {
  const call = formatCompactCall("learning_context", "facts for math");
  expect(call.lines[0]).toContain("learning_context");
  expect(call.lines[0]).toContain("facts for math");
});

test("formatCompactResult toggles between concise single-line summary and full details", () => {
  const unexpanded = formatCompactResult("Context updated", "Full JSON blurb\nline2", { expanded: false });
  expect(unexpanded.lines).toHaveLength(1);
  expect(unexpanded.lines[0]).toContain("Context updated");
  expect(unexpanded.lines[0]).toContain("details");
  expect(unexpanded.lines[0]).not.toContain("Ctrl+E");

  const expanded = formatCompactResult("Context updated", "Full JSON blurb\nline2", { expanded: true });
  expect(expanded.lines.length).toBeGreaterThan(1);
  expect(expanded.lines).toContain("Full JSON blurb");
  expect(expanded.lines).toContain("line2");
});

test("tool detail hints follow the active expand binding, including remapped and unbound keys", () => {
  const previous = getKeybindings();
  const bindings = new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } });
  const theme = { fg: (_color: string, text: string) => text } as Theme;
  type Context = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
  const context = { isError: true } as Context;
  const renderResult = nativeToolPresentation("learning_skill").renderResult!;
  const result = { content: [{ type: "text" as const, text: "Synthetic skill failure" }], details: undefined };
  try {
    setKeybindings(bindings);
    for (const keys of [["ctrl+o"], ["alt+o"], []] as const) {
      bindings.setUserBindings({ "app.tools.expand": [...keys] });
      const compact = formatCompactResult("Summary", "Full details").lines.join("\n");
      const native = renderResult(result, { expanded: false, isPartial: false }, theme, context).render(160).join("\n");
      for (const text of [compact, native]) {
        expect(text).toContain(keys[0] ?? "/hotkeys");
        expect(text).not.toContain("Ctrl+E");
        if (keys[0] !== "ctrl+o") expect(text.toLowerCase()).not.toContain("ctrl+o");
      }
      expect(native).toContain("learning_skill failed");
      expect(native).toContain(result.content[0]!.text);
      expect(renderResult(result, { expanded: true, isPartial: false }, theme, context).render(160).join("\n")).toContain(result.content[0]!.text);
    }
  } finally { setKeybindings(previous); }
});

test("tool result renderers format compact summaries without dumping raw JSON", () => {
  const contextResult = presentationRenderers.learning_context.result(
    { content: [{ text: JSON.stringify({ goal: { body: { objective: "Master calculus" } } }) }] },
    { expanded: false },
  );
  expect(contextResult.lines[0]).toContain("Master calculus");
  expect(contextResult.lines[0]).not.toContain('{"goal":');

  const defineResult = presentationRenderers.learning_define.result(
    { content: [{ text: JSON.stringify({ kind: "task_definition", body: { title: "Find the derivative" } }) }] },
    { expanded: false },
  );
  expect(defineResult.lines[0]).toContain("Find the derivative");

  const recordResult = presentationRenderers.learning_record.result(
    { content: [{ text: JSON.stringify({ kind: "assessment", payload: { outcome: "success" } }) }] },
    { expanded: false },
  );
  expect(recordResult.lines[0]).toContain("success");
});
