import type { SagePaths } from "../../../packages/runtime/src/paths.ts";
import { bootstrapSageHome } from "../../../packages/runtime/src/bootstrap.ts";
import { managePlugin } from "../../../packages/pi/src/plugins.ts";
import { manageResources } from "../../../packages/pi/src/resources.ts";
import { updatePi } from "../../../packages/pi/src/updates.ts";

type PackageAction = "add" | "remove" | "list" | "update";
type ResourceAction = "add" | "remove" | "list" | "enable" | "disable";
export type CustomizationCommand =
  | { kind: "package"; action: PackageAction; source?: string; trusted: boolean; json: boolean }
  | { kind: "extensions"; action: ResourceAction; path?: string; trusted: boolean; json: boolean }
  | { kind: "config"; json: boolean }
  | { kind: "engine"; json: boolean };

/** Pi's familiar verbs, with one scope: Sage's isolated home. */
export function parseCustomization(command: string | undefined, args: string[]): CustomizationCommand | undefined {
  if (!command || !["install", "remove", "uninstall", "list", "update", "extensions", "config"].includes(command)) return;
  const flags = args.filter(arg => arg.startsWith("-"));
  const allowed = ["--trust", "--json", ...(command === "update" ? ["--extensions"] : [])];
  for (const flag of flags) if (!allowed.includes(flag)) throw new Error(`Unsupported option ${flag}. These commands only configure Sage, never global Pi or invocation .pi settings.`);
  if (new Set(flags).size !== flags.length) throw new Error("Do not repeat command options");
  const positional = args.filter(arg => !arg.startsWith("-"));
  const json = flags.includes("--json"), trusted = flags.includes("--trust");
  if (command === "config") {
    if (positional.length || trusted) throw new Error("Usage: sage config [--json]. Use sage extensions enable|disable PATH to switch an extension.");
    return { kind: "config", json };
  }
  if (command === "extensions") {
    const action = positional[0] ?? "list";
    if (!["list", "add", "remove", "enable", "disable"].includes(action) || (action === "list" ? positional.length > 1 : positional.length !== 2)) throw new Error("Usage: sage extensions [list] | add|remove|enable|disable PATH [--trust] [--json]");
    if (trusted && action !== "add" && action !== "enable") throw new Error("--trust is only needed for adding or enabling extensions");
    return { kind: "extensions", action: action as ResourceAction, path: positional[1], trusted, json };
  }
  if (command === "list") {
    if (positional.length || trusted) throw new Error("Usage: sage list [--json]");
    return { kind: "package", action: "list", trusted: false, json };
  }
  if (command === "update" && !positional.length && !flags.includes("--extensions")) {
    if (trusted) throw new Error("Use sage update --extensions --trust to update packages, or sage update to update Pi");
    return { kind: "engine", json };
  }
  if (command === "update") {
    if (positional.length > 1 || (positional.length && flags.includes("--extensions"))) throw new Error("Usage: sage update | sage update --extensions --trust | sage update SOURCE --trust");
    return { kind: "package", action: "update", source: positional[0], trusted, json };
  }
  if (positional.length !== 1) throw new Error(`Usage: sage ${command} SOURCE${command === "install" ? " --trust" : ""} [--json]`);
  if (trusted && command !== "install") throw new Error("Removing a package does not require --trust");
  return { kind: "package", action: command === "install" ? "add" : "remove", source: positional[0], trusted, json };
}

const native = { bootstrap: bootstrapSageHome, plugin: managePlugin, resources: manageResources, update: updatePi };
interface CustomizationOperations {
  bootstrap: typeof bootstrapSageHome;
  plugin: (paths: SagePaths, action: string, source?: string, trusted?: boolean) => Promise<unknown>;
  resources: (paths: SagePaths, action: string, kind?: string, path?: string, trusted?: boolean) => Promise<unknown>;
  update: (paths: SagePaths) => Promise<unknown>;
}
export async function executeCustomization(paths: SagePaths, command: CustomizationCommand, operations: CustomizationOperations = native): Promise<unknown> {
  if (command.kind === "engine") return operations.update(paths);
  await operations.bootstrap(paths);
  if (command.kind === "package") return operations.plugin(paths, command.action, command.source, command.trusted);
  return operations.resources(paths, command.kind === "config" ? "list" : command.action, command.kind === "extensions" ? "extensions" : undefined, command.kind === "extensions" ? command.path : undefined, command.kind === "extensions" && command.trusted);
}

export function formatCustomization(command: CustomizationCommand, result: unknown): string {
  if (command.json) return JSON.stringify(result, null, 2);
  const value = result as Record<string, unknown>;
  if (command.kind === "engine") {
    return `Pi updated for Sage${value.version ? `: ${value.version}` : ""}. Global Pi is unchanged. Restart the tutor to use it.`;
  }
  if (command.kind === "package") {
    if (command.action === "list") {
      const packages = result as Array<{ source: string; installedPath?: string }>;
      return packages.length ? `Installed Pi packages (Sage only):\n${packages.map(pkg => `  ${/^(npm:|git:|https?:)/.test(pkg.source) ? pkg.source : pkg.installedPath ?? pkg.source}${pkg.installedPath ? "" : " (not installed)"}`).join("\n")}\nUse sage extensions to see loaded extensions.` : "No Pi packages installed. Add one with sage install SOURCE --trust.";
    }
    const source = value.source ?? command.source ?? "all packages";
    if (command.action === "remove" && value.removed === false) return `Package not configured: ${source}`;
    return `${command.action === "add" ? "Installed" : command.action === "remove" ? "Removed" : "Updated"}: ${source}\nApplies on the next launch or /reload. Global Pi is unchanged.`;
  }
  if (command.kind === "extensions" && command.action !== "list") return `${command.action === "disable" ? "Disabled" : command.action === "enable" ? "Enabled" : command.action === "add" ? "Registered" : "Unregistered"}: ${value.path}\nApplies on the next launch or /reload. Files are not deleted.${command.action === "remove" ? " Auto-discovered/packaged extensions must be disabled to stop loading." : ""}`;
  const extensions = (value.extensions ?? []) as string[];
  const lines = [command.kind === "config" ? "Sage configuration (global Pi is unchanged):" : "Loaded extensions (Sage only):", ...extensions.map(path => `  ${path}`)];
  if (!extensions.length) lines.push("  No user extensions loaded.");
  if (command.kind === "config") {
    for (const kind of ["skills", "prompts", "themes"]) {
      const entries = (value[kind] ?? []) as Array<{ name: string; path?: string }>;
      lines.push(`${kind}: ${entries.length ? entries.map(entry => entry.name).join(", ") : "none"}`);
    }
    lines.push("Use sage extensions enable|disable PATH; sage theme list; /settings in the tutor.");
  }
  const errors = (value.errors ?? []) as Array<{ path: string; error: string }>;
  for (const error of errors) lines.push(`Error loading ${error.path}: ${error.error}`);
  for (const diagnostic of (value.diagnostics ?? []) as Array<{ type: string; message: string; path?: string }>) lines.push(`${diagnostic.type}: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`);
  lines.push("Sage's learning tools and planner are built in, not removable packages.");
  return lines.join("\n");
}
