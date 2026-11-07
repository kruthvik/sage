import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageSnapshot, UsageTracker } from "../../runtime/src/usage.ts";

function status(snapshot: UsageSnapshot): string {
  if (snapshot.enabled && !snapshot.available) return "Local usage tracking unavailable; no uploads. Use /usage off.";
  return `Local usage tracking: ${snapshot.enabled ? "on" : "off"}. Total sessions: ${snapshot.total_sessions}. Sage open hours: ${snapshot.total_hours.toFixed(2)}. No uploads. /usage on|off`;
}
function line(snapshot: UsageSnapshot, width: number): string {
  const enabled = snapshot.enabled ? "on" : "off", hours = snapshot.total_hours.toFixed(2);
  const full = snapshot.enabled && !snapshot.available ? "Usage unavailable" : `Hours ${hours} | ${enabled}`;
  const short = snapshot.enabled && !snapshot.available ? "usage !" : `${enabled} ${hours}h`;
  const text = (width < full.length ? short : full).slice(0, Math.max(0, width));
  return text.padStart(Math.max(0, width));
}

/** Local application controls only: never model messages, learner work or Pi install telemetry. */
export function registerUsageControls(pi: ExtensionAPI, usage: UsageTracker): void {
  let detach: (() => void) | undefined;
  const change = async (enabled: boolean, ctx: ExtensionContext) => {
    try { await usage.setEnabled(enabled); ctx.ui.notify(status(usage.snapshot())); }
    catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Could not change local usage tracking", "warning"); }
  };
  pi.registerCommand("usage", { description: "Local sessions/open-hours tracking: /usage on|off|status (no uploads)", handler: async (args, ctx) => {
    const value = args.trim() || "status";
    if (value === "status") { ctx.ui.notify(status(usage.snapshot())); return; }
    if (value !== "on" && value !== "off") { ctx.ui.notify("Use /usage on|off|status; no model or dialog is needed", "warning"); return; }
    await change(value === "on", ctx);
  } });
  pi.registerCommand("sage-settings", { description: "Sage settings; local usage tracking is the first item", handler: async (_args, ctx) => {
    if (!ctx.hasUI) { ctx.ui.notify(status(usage.snapshot())); return; }
    const current = usage.snapshot(), labels = [`Usage tracking: ${current.enabled ? "on" : "off"} (toggle)`, "Close"];
    const selected = await ctx.ui.select("Sage settings — local only, no uploads", labels);
    if (selected === labels[0]) await change(!current.enabled, ctx);
  } });
  pi.on("session_start", (_event, ctx) => {
    detach?.(); detach = undefined;
    if (!ctx.hasUI) return;
    ctx.ui.setWidget("sage-usage", tui => {
      const unsubscribe = usage.subscribe(() => tui.requestRender()); detach = unsubscribe;
      return { render: width => [line(usage.snapshot(), width)], invalidate() {}, dispose: unsubscribe };
    }, { placement: "belowEditor" });
    const snapshot = usage.snapshot(); if (snapshot.enabled && snapshot.error) ctx.ui.notify(snapshot.error, "warning");
  });
  pi.on("session_shutdown", async () => {
    detach?.(); detach = undefined;
    // Native quit bypasses launcher finally; session switches must flush without stopping tracking.
    await usage.flush();
  });
}
