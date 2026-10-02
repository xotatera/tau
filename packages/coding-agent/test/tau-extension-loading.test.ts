import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { VIRTUAL_MODULES } from "../src/core/extensions/virtual-modules.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const fixtures = fileURLToPath(new URL("fixtures/tau-compat/", import.meta.url));

// Dropping a supported alias, resolving a second host, or changing registration semantics breaks these probes.
describe("Tau extension compatibility", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "tau-extension-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	for (const family of ["earendil", "mario"]) {
		it(`loads unchanged ${family} fixture`, async () => {
			const result = await loadExtensions([join(fixtures, `${family}-extension.ts`)], cwd);
			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(1);
			const extension = result.extensions[0]!;
			expect(extension.tools.has("compat_probe")).toBe(true);
			const tool = extension.tools.get("compat_probe")!.definition;
			const output = await tool.execute("probe", {}, undefined, undefined, {} as ExtensionToolContext);
			expect(output.content).toEqual([{ type: "text", text: "compatible" }]);
			expect(output.details).toMatchObject({
				hostSessionManager: SessionManager,
				Agent,
				Text,
				getModel,
				compiled: true,
				validated: true,
			});
			expect(extension.commands.get("compat-command")?.description).toBe("Legacy command");
			expect(extension.flags.get("compat-flag")?.default).toBe(true);
			expect(result.runtime.flagValues.get("compat-flag")).toBe(true);
			expect(extension.shortcuts.get("ctrl+shift+j")?.description).toBe("Legacy shortcut");
			expect(extension.messageRenderers.has("compat-message")).toBe(true);
			expect(extension.entryRenderers?.has("compat-entry")).toBe(true);
			expect(result.runtime.pendingProviderRegistrations).toEqual([
				{
					name: "compat-provider",
					config: { baseUrl: "http://127.0.0.1:1", models: [] },
					extensionPath: extension.path,
				},
			]);
		});
	}

	it("preserves every supported legacy module value", () => {
		for (const module of [
			"pi-agent-core",
			"pi-tui",
			"pi-ai",
			"pi-ai/compat",
			"pi-ai/oauth",
			"pi-ai/providers/all",
			"pi-coding-agent",
		]) {
			expect(VIRTUAL_MODULES[`@mariozechner/${module}`]).toBe(VIRTUAL_MODULES[`@earendil-works/${module}`]);
			expect(VIRTUAL_MODULES[`@earendil-works/${module}`]).toBeDefined();
		}
		for (const suffix of ["", "/compile", "/value"]) {
			expect(VIRTUAL_MODULES[`@sinclair/typebox${suffix}`]).toBe(VIRTUAL_MODULES[`typebox${suffix}`]);
		}
	});

	it("loads Tau imports against the same host as legacy imports", async () => {
		// Outside the workspace: package self-resolution must not mask a missing loader alias.
		const path = join(cwd, "extension.ts");
		writeFileSync(
			path,
			'import { SessionManager } from "@xotatera/tau-coding-agent"; export default function(pi) { pi.registerFlag("same-host", { type: "boolean", default: typeof SessionManager.inMemory === "function" }); }',
		);
		const result = await loadExtensions([path], cwd);
		expect(result.errors).toEqual([]);
		expect(result.runtime.flagValues.get("same-host")).toBe(true);
		expect(VIRTUAL_MODULES["@xotatera/tau-coding-agent"]).toBe(VIRTUAL_MODULES["@earendil-works/pi-coding-agent"]);
	});

	it("retains host identity with a physical legacy host dependency present", async () => {
		const packageRoot = join(cwd, "node_modules", "@earendil-works", "pi-coding-agent");
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-coding-agent", main: "index.js" }),
		);
		writeFileSync(join(packageRoot, "index.js"), 'throw new Error("physical duplicate host loaded");');
		const fixture = join(cwd, "extension.ts");
		writeFileSync(
			fixture,
			'import { SessionManager } from "@earendil-works/pi-coding-agent"; export default function(pi) { pi.registerFlag("host", { type: "boolean", default: typeof SessionManager.inMemory === "function" }); }',
		);
		const result = await loadExtensions([fixture], cwd);
		expect(result.errors).toEqual([]);
		expect(result.runtime.flagValues.get("host")).toBe(true);
	});
});
