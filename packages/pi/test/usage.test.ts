import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { UsageTracker } from "../../runtime/src/usage.ts";

async function harness() {
  const url = new URL("../src/usage.ts", import.meta.url); expect(await Bun.file(url).exists()).toBe(true);
  const { registerUsageControls } = await import(url.href);
  const commands = new Map<string, RegisteredCommand>(), hooks = new Map<string, (event: unknown, context: unknown) => Promise<unknown>>();
  const writes: boolean[] = [], notices: string[] = [], listeners = new Set<() => void>(); let enabled = true;
  const tracker: UsageTracker = { async start() {}, async stop() {}, async flush() {}, async setEnabled(value) { enabled = value; writes.push(value); }, snapshot: () => ({ enabled, available: true, total_sessions: 3, total_hours: 1.25 }), subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; } };
  const api = { registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); }, on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) { hooks.set(name, handler); return () => {}; } };
  registerUsageControls(api as unknown as ExtensionAPI, tracker);
  const ctx = { hasUI: true, ui: { notify(text: string) { notices.push(text); } } };
  return { commands, hooks, tracker, writes, notices, listeners, ctx };
}

test("usage UI: direct opt-out needs no model, dialog, learner message or idle gate", async () => {
  const f = await harness();
  await f.commands.get("usage")!.handler("off", { ...f.ctx, isIdle: () => false } as unknown as ExtensionCommandContext);
  expect(f.writes).toEqual([false]); expect(f.notices.join(" ")).toContain("off");
  await f.commands.get("usage")!.handler("status", f.ctx as unknown as ExtensionCommandContext);
  expect(f.notices.join(" ")).toContain("3"); expect(f.notices.join(" ")).toContain("1.25");
  await f.commands.get("usage")!.handler("invalid", f.ctx as unknown as ExtensionCommandContext);
  expect(f.writes).toEqual([false]);
});

test.each(["toggle", "cancel", "invalid"] as const)("usage settings: tracking is first and %s is handled safely", async scenario => {
  const f = await harness(); let options: string[] = [];
  const ctx = { ...f.ctx, ui: { ...f.ctx.ui, select: async (_title: string, labels: string[]) => { options = labels; return scenario === "toggle" ? labels[0] : scenario === "invalid" ? "Unknown option" : undefined; } } };
  await f.commands.get("sage-settings")!.handler("", ctx as unknown as ExtensionCommandContext);
  expect(options[0]).toContain("Usage tracking"); expect(f.writes).toEqual(scenario === "toggle" ? [false] : []);
});

test("usage status: right-aligned below-editor widget preserves the native footer and releases its listener", async () => {
  const f = await harness(); let component: { render(width: number): string[]; dispose?(): void } | undefined, placement: unknown;
  const ctx = { ...f.ctx, ui: { ...f.ctx.ui, setWidget(_key: string, factory: (tui: { requestRender(): void }, theme: unknown) => typeof component, options: unknown) { placement = options; component = factory({ requestRender() {} }, {}); } } };
  await f.hooks.get("session_start")!({}, ctx);
  expect(placement).toEqual({ placement: "belowEditor" });
  expect(component!.render(40)[0]).toHaveLength(40); expect(component!.render(40)[0]).toMatch(/^\s+.*1\.25.*on$/);
  expect(component!.render(8)[0]!.length).toBeLessThanOrEqual(8);
  expect(f.listeners.size).toBe(1);
  let flushed = false;
  f.tracker.flush = async () => { flushed = true; };
  f.tracker.stop = async () => { throw new Error("Session switches must not stop launch tracking"); };
  await f.hooks.get("session_shutdown")!({}, ctx); component?.dispose?.(); expect(f.listeners.size).toBe(0);
  expect(flushed).toBe(true);
});
