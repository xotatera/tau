import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inventoryPiImport, readImportPreferences } from "../src/core/pi-import/inventory.ts";
import type { ImportOptions } from "../src/core/pi-import/types.ts";

describe("Pi import read-only inventory", () => {
	let root: string;
	let options: ImportOptions;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tau-import-inventory-"));
		options = {
			sourceAgentDir: join(root, ".pi", "agent"),
			destinationAgentDir: join(root, ".tau", "agent"),
			preferences: false,
			onConflict: "error",
		};
		mkdirSync(join(options.sourceAgentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(options.sourceAgentDir, "extensions", "probe.ts"),
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(root, "executed"))}, "unsafe"); export default function() {}`,
		);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("dry run performs no writes or execution", async () => {
		const source = readFileSync(join(options.sourceAgentDir, "extensions", "probe.ts"));
		const plan = await inventoryPiImport(options);
		expect(plan.resources).toHaveLength(1);
		expect(plan.resources[0]?.kind).toBe("extension");
		expect(plan.id).toMatch(/^[a-f0-9]{64}$/);
		expect(existsSync(options.destinationAgentDir)).toBe(false);
		expect(existsSync(join(root, "executed"))).toBe(false);
		expect(readFileSync(join(options.sourceAgentDir, "extensions", "probe.ts"))).toEqual(source);
	});

	it("requires explicit project source", async () => {
		const project = join(root, "project");
		mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(project, ".pi", "extensions", "project.ts"), "export default function() {}");
		const withoutProject = await inventoryPiImport(options);
		expect(withoutProject.resources.map((resource) => resource.id)).not.toContain(
			"project:extension:extensions/project.ts",
		);
		const withProject = await inventoryPiImport({ ...options, sourceProjectDir: project });
		expect(withProject.resources.map((resource) => resource.id)).toContain("project:extension:extensions/project.ts");
	});

	it("never reports excluded secret values", async () => {
		const secret = "synthetic-secret-do-not-report";
		writeFileSync(join(options.sourceAgentDir, "auth.json"), JSON.stringify({ key: secret }));
		writeFileSync(join(options.sourceAgentDir, "trust.json"), secret);
		mkdirSync(join(options.sourceAgentDir, "sessions"));
		writeFileSync(join(options.sourceAgentDir, "sessions", "secret.jsonl"), secret);
		writeFileSync(
			join(options.sourceAgentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "faux",
				defaultModel: "probe",
				defaultThinkingLevel: "high",
				theme: "dark",
				systemPrompt: secret,
				npmCommand: [secret],
				mcpServers: { secret },
			}),
		);
		const plan = await inventoryPiImport({ ...options, preferences: true });
		expect(JSON.stringify(plan)).not.toContain(secret);
		expect(await readImportPreferences({ ...options, preferences: true })).toEqual({
			defaultProvider: "faux",
			defaultModel: "probe",
			defaultThinkingLevel: "high",
			theme: "dark",
		});
		expect(await readImportPreferences(options)).toEqual({});
	});

	it("plan hash covers source content, reviewed options, selected preferences and base settings", async () => {
		const first = await inventoryPiImport(options);
		expect((await inventoryPiImport(options)).id).toBe(first.id);
		writeFileSync(join(options.sourceAgentDir, "extensions", "probe.ts"), "export default function() {} // changed");
		expect((await inventoryPiImport(options)).id).not.toBe(first.id);
		const beforePreferences = await inventoryPiImport({ ...options, preferences: true });
		writeFileSync(join(options.sourceAgentDir, "settings.json"), JSON.stringify({ defaultModel: "different" }));
		expect((await inventoryPiImport({ ...options, preferences: true })).id).not.toBe(beforePreferences.id);
		const beforeSettings = await inventoryPiImport(options);
		mkdirSync(options.destinationAgentDir, { recursive: true });
		writeFileSync(join(options.destinationAgentDir, "settings.json"), "{}");
		expect((await inventoryPiImport(options)).id).not.toBe(beforeSettings.id);
	});

	it("unknown selections and unavailable packages are blocking but can be deselected", async () => {
		writeFileSync(join(options.sourceAgentDir, "settings.json"), JSON.stringify({ packages: ["npm:not-installed"] }));
		expect((await inventoryPiImport(options)).diagnostics.some((item) => item.severity === "error")).toBe(true);
		const selected = await inventoryPiImport({ ...options, selectedIds: ["user:extension:extensions/probe.ts"] });
		expect(selected.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
		expect((await inventoryPiImport({ ...options, selectedIds: ["unknown"] })).diagnostics).toContainEqual(
			expect.objectContaining({ code: "unknown-selection", severity: "error" }),
		);
	});

	it("rejects secret files disguised by contained symlinks", async () => {
		const packageRoot = join(options.sourceAgentDir, "extensions", "package");
		mkdirSync(packageRoot);
		writeFileSync(join(packageRoot, "auth.json"), "synthetic-secret");
		symlinkSync("auth.json", join(packageRoot, "support.json"));
		const plan = await inventoryPiImport(options);
		expect(plan.diagnostics).toContainEqual(
			expect.objectContaining({ severity: "error", message: expect.stringContaining("excluded") }),
		);
	});

	it("rejects FIFO metadata without blocking or reading it", ({ skip }) => {
		if (process.platform !== "linux") {
			skip("FIFO fixture requires Linux");
			return;
		}
		execFileSync("mkfifo", [join(options.sourceAgentDir, "settings.json")]);
		const script = join(root, "inventory.mjs");
		writeFileSync(
			script,
			`import { inventoryPiImport } from ${JSON.stringify(new URL("../src/core/pi-import/inventory.ts", import.meta.url).href)}; const plan = await inventoryPiImport(${JSON.stringify(options)}); console.log(JSON.stringify(plan.diagnostics));`,
		);
		const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 1000 });
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toContainEqual(
			expect.objectContaining({ code: "invalid-settings", severity: "error" }),
		);
	});

	it("rejects an excluded directory disguised as a selected resource root", async () => {
		const credentials = join(options.sourceAgentDir, ".aws");
		mkdirSync(credentials);
		writeFileSync(join(credentials, "config"), "synthetic-secret");
		symlinkSync(credentials, join(options.sourceAgentDir, "extensions", "disguised"), "dir");
		const plan = await inventoryPiImport(options);
		expect(plan.diagnostics).toContainEqual(
			expect.objectContaining({ severity: "error", message: expect.stringContaining("excluded") }),
		);
	});

	it("does not mistake unrelated files for supported resources", async () => {
		writeFileSync(join(options.sourceAgentDir, "extensions", "README.md"), "not an extension");
		mkdirSync(join(options.sourceAgentDir, "themes"));
		writeFileSync(join(options.sourceAgentDir, "themes", "notes.txt"), "not a theme");
		const plan = await inventoryPiImport(options);
		expect(plan.resources.map((resource) => resource.id)).toEqual(["user:extension:extensions/probe.ts"]);
	});

	it("deduplicates configured references to already discovered canonical resources", async () => {
		writeFileSync(
			join(options.sourceAgentDir, "settings.json"),
			JSON.stringify({ extensions: ["extensions/probe.ts"] }),
		);
		const plan = await inventoryPiImport(options);
		expect(plan.resources).toHaveLength(1);
	});

	it("a pending journal is reported without recovery writes", async () => {
		const directory = join(options.destinationAgentDir, "imports", "pi");
		mkdirSync(directory, { recursive: true });
		const path = join(directory, "journal.json");
		const bytes = '{"state":"settings-prepared","synthetic":"leave unchanged"}';
		writeFileSync(path, bytes);
		const plan = await inventoryPiImport(options);
		expect(plan.diagnostics).toContainEqual(expect.objectContaining({ code: "pending-journal", severity: "error" }));
		expect(readFileSync(path, "utf8")).toBe(bytes);
		expect(existsSync(join(directory, "journal.json.lock"))).toBe(false);
	});
});
