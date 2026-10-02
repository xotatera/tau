import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handlePiImportCommand } from "../src/cli/pi-import.ts";
import { inventoryPiImport } from "../src/core/pi-import/inventory.ts";
import * as storage from "../src/core/pi-import/storage.ts";

describe("Pi import CLI", () => {
	let root: string;
	let source: string;
	let destination: string;
	let exitCode: typeof process.exitCode;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tau-import-cli-"));
		source = join(root, "source with spaces");
		destination = join(root, "tau");
		mkdirSync(join(source, "extensions"), { recursive: true });
		writeFileSync(join(source, "extensions", "probe.ts"), "export default function() {}");
		exitCode = process.exitCode;
		process.exitCode = undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		process.exitCode = exitCode;
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	it("dispatches before normal startup can create settings or load extensions", () => {
		const script = fileURLToPath(new URL("../../../tau-test.sh", import.meta.url));
		const result = spawnSync("bash", [script, "import", "pi", "--from", source], {
			cwd: root,
			env: {
				PATH: process.env.PATH,
				HOME: root,
				TAU_CODING_AGENT_DIR: destination,
				PI_OFFLINE: "1",
				PI_NO_LOCAL_LLM: "1",
			},
			encoding: "utf8",
			timeout: 10_000,
		});
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout).resources).toHaveLength(1);
		expect(existsSync(destination)).toBe(false);
	});

	it("defaults to a zero-write content-free inventory", async () => {
		expect(await handlePiImportCommand(["import", "pi", "--from", source], destination)).toBe(true);
		expect(process.exitCode ?? 0).toBe(0);
		expect(existsSync(destination)).toBe(false);
		const output = String(vi.mocked(console.log).mock.calls[0]?.[0]);
		expect(JSON.parse(output).id).toMatch(/^[a-f0-9]{64}$/);
		expect(output).not.toContain("export default");
	});

	for (const flags of [
		["--apply"],
		["--apply", "--plan-hash", "0".repeat(64)],
		["--from"],
		["--project"],
		["--select"],
		["--on-conflict", "replace"],
		["--unknown"],
		["--select", "unknown"],
		["--plan-hash", "1".repeat(64)],
	]) {
		it(`rejects unreviewed or invalid flags without writes: ${flags.join(" ")}`, async () => {
			await handlePiImportCommand(["import", "pi", "--from", source, ...flags], destination);
			expect(process.exitCode).toBe(1);
			expect(existsSync(destination)).toBe(false);
		});
	}

	it("applies only a matching reviewed hash, remaining inactive until explicit activation", async () => {
		const options = {
			sourceAgentDir: source,
			destinationAgentDir: destination,
			preferences: false,
			onConflict: "error" as const,
		};
		const plan = await inventoryPiImport(options);
		await handlePiImportCommand(["import", "pi", "--from", source, "--apply", "--plan-hash", plan.id], destination);
		expect(process.exitCode ?? 0).toBe(0);
		expect(existsSync(join(destination, "settings.json"))).toBe(false);
		const receipt = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));
		await handlePiImportCommand(["import", "activate", receipt.id], destination);
		expect(JSON.parse(readFileSync(join(destination, "settings.json"), "utf8")).extensions).toHaveLength(1);
	});

	it("parses repeated selections, explicit project, preferences and skip policy", async () => {
		const project = join(root, "project");
		mkdirSync(join(project, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(project, ".pi", "prompts", "review.md"), "Review this");
		await handlePiImportCommand(
			[
				"import",
				"pi",
				"--from",
				source,
				"--project",
				project,
				"--select",
				"user:extension:extensions/probe.ts",
				"--select",
				"project:prompt:prompts/review.md",
				"--preferences",
				"--on-conflict",
				"skip",
			],
			destination,
		);
		const plan = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]));
		expect(plan.resources).toHaveLength(2);
		expect(plan.options.preferences).toBe(true);
		expect(plan.options.onConflict).toBe("skip");
		expect(existsSync(destination)).toBe(false);
	});

	it("reviewed CLI apply retries a pending valid journal without requiring ordinary startup", async () => {
		const plan = await inventoryPiImport({
			sourceAgentDir: source,
			destinationAgentDir: destination,
			preferences: false,
			onConflict: "error",
		});
		const original = storage.atomicWrite;
		vi.spyOn(storage, "atomicWrite").mockImplementation((path, data) => {
			original(path, data);
			if (path.endsWith("/journal.json") && JSON.parse(data.toString()).state === "staged")
				throw new Error("injected crash");
		});
		await handlePiImportCommand(["import", "pi", "--from", source, "--apply", "--plan-hash", plan.id], destination);
		expect(process.exitCode).toBe(1);
		vi.mocked(storage.atomicWrite).mockRestore();
		process.exitCode = undefined;
		await handlePiImportCommand(["import", "pi", "--from", source, "--apply", "--plan-hash", plan.id], destination);
		expect(process.exitCode ?? 0).toBe(0);
		expect(existsSync(join(destination, "imports", "pi", "journal.json"))).toBe(false);
	});

	it("rejects missing, unknown or malformed activation IDs without writes", async () => {
		for (const args of [
			["import", "activate"],
			["import", "activate", "unknown"],
			["import", "activate", "0".repeat(64)],
			["import", "activate", "0".repeat(64), "--unknown"],
		]) {
			await handlePiImportCommand(args, destination);
			expect(process.exitCode).toBe(1);
			expect(existsSync(destination)).toBe(false);
		}
	});
});
