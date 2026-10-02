import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { activatePiImport, applyPiImport, inventoryPiImport } from "../../src/core/pi-import/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

it("imports and activates unchanged fixtures without Pi sources", async () => {
	const root = mkdtempSync(join(tmpdir(), "tau-independent-"));
	let harness: Harness | undefined;
	try {
		const pi = join(root, "pi");
		const tau = join(root, "tau");
		mkdirSync(join(pi, "extensions"), { recursive: true });
		const fixtureRoot = fileURLToPath(new URL("../fixtures/tau-compat/", import.meta.url));
		const extension = join(pi, "extensions", "legacy.ts");
		cpSync(join(fixtureRoot, "earendil-extension.ts"), extension);
		const source = readFileSync(extension);
		const packageRoot = join(pi, "installed-package");
		cpSync(join(fixtureRoot, "package"), packageRoot, { recursive: true });
		const dependencyPackage = join(pi, "extensions", "with-dependency");
		mkdirSync(join(dependencyPackage, "node_modules", "local-dependency"), { recursive: true });
		writeFileSync(
			join(dependencyPackage, "package.json"),
			JSON.stringify({
				name: "supported-snapshot",
				type: "module",
				dependencies: { "local-dependency": "1.0.0" },
				pi: { extensions: ["index.ts"] },
			}),
		);
		writeFileSync(
			join(dependencyPackage, "node_modules", "local-dependency", "package.json"),
			JSON.stringify({ name: "local-dependency", version: "1.0.0", main: "index.js" }),
		);
		writeFileSync(
			join(dependencyPackage, "node_modules", "local-dependency", "index.js"),
			"module.exports = { answer: 42 };\n",
		);
		writeFileSync(
			join(dependencyPackage, "index.ts"),
			'import { answer } from "local-dependency"; export default function(pi) { pi.registerTool({ name: "import_dependency", label: "Dependency", description: "Local dependency probe", parameters: {}, async execute() { return { content: [{ type: "text", text: String(answer) }], details: {} }; } }); }',
		);
		writeFileSync(join(pi, "settings.json"), JSON.stringify({ packages: [packageRoot] }));
		const plan = await inventoryPiImport({
			sourceAgentDir: pi,
			destinationAgentDir: tau,
			preferences: false,
			onConflict: "error",
		});
		expect(plan.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
		const receipt = await applyPiImport(plan);
		await activatePiImport(receipt.id, tau);
		expect(readFileSync(extension)).toEqual(source);
		const settings = readFileSync(join(tau, "settings.json"), "utf8");
		expect(settings).not.toContain(pi);
		rmSync(pi, { recursive: true });
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: tau });
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions.some((entry) => entry.commands.has("legacy-package"))).toBe(true);
		harness = await createHarness({ resourceLoader: loader });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("compat_probe", {}), fauxToolCall("import_dependency", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("offline imported tools complete"),
		]);
		await harness.session.prompt("probe imported tools");
		expect(getToolResult(harness, "compat_probe").details).toMatchObject({
			hostSessionManager: SessionManager,
			compiled: true,
			validated: true,
		});
		expect(getMessageText(getToolResult(harness, "import_dependency"))).toBe("42");
	} finally {
		harness?.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});
