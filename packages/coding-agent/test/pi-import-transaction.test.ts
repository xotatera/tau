import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inventoryPiImport } from "../src/core/pi-import/inventory.ts";
import { publishReceipt } from "../src/core/pi-import/recovery.ts";
import { stagePiImport } from "../src/core/pi-import/snapshot.ts";
import { activatePiImport, applyPiImport } from "../src/core/pi-import/transaction.ts";
import type { ImportOptions } from "../src/core/pi-import/types.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("Pi import activation transactions", () => {
	let root: string;
	let options: ImportOptions;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tau-import-transaction-"));
		options = {
			sourceAgentDir: join(root, "pi"),
			destinationAgentDir: join(root, "tau"),
			preferences: true,
			onConflict: "error",
		};
		mkdirSync(join(options.sourceAgentDir, "extensions"), { recursive: true });
		mkdirSync(options.destinationAgentDir);
		writeFileSync(join(options.sourceAgentDir, "extensions", "probe.ts"), "export default function() {}");
		writeFileSync(join(options.sourceAgentDir, "settings.json"), JSON.stringify({ defaultModel: "new-model" }));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("conflicts default to error", async () => {
		writeFileSync(join(options.destinationAgentDir, "settings.json"), JSON.stringify({ defaultModel: "old-model" }));
		const plan = await inventoryPiImport(options);
		await expect(applyPiImport(plan)).rejects.toThrow("conflict");
		expect(JSON.parse(readFileSync(join(options.destinationAgentDir, "settings.json"), "utf8"))).toEqual({
			defaultModel: "old-model",
		});
	});

	it("skip leaves existing values untouched", async () => {
		writeFileSync(
			join(options.destinationAgentDir, "settings.json"),
			JSON.stringify({ defaultModel: "old-model", theme: "light" }),
		);
		const plan = await inventoryPiImport({ ...options, onConflict: "skip" });
		const receipt = await applyPiImport(plan);
		expect(JSON.parse(readFileSync(join(options.destinationAgentDir, "settings.json"), "utf8"))).toEqual({
			defaultModel: "old-model",
			theme: "light",
		});
		await activatePiImport(receipt.id, options.destinationAgentDir);
		const settings = JSON.parse(readFileSync(join(options.destinationAgentDir, "settings.json"), "utf8"));
		expect(settings.defaultModel).toBe("old-model");
		expect(settings.theme).toBe("light");
		expect(settings.extensions).toHaveLength(1);
		expect(JSON.stringify(settings)).not.toContain(options.sourceAgentDir);
	});

	function duplicateSources(): ImportOptions {
		const sourceProjectDir = join(root, "project");
		mkdirSync(join(sourceProjectDir, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(sourceProjectDir, ".pi", "extensions", "probe.ts"), "export default function() {} // project");
		return { ...options, sourceProjectDir };
	}

	it("same-batch same-name resources fail error policy before settings publication", async () => {
		const plan = await inventoryPiImport(duplicateSources());
		expect(plan.resources).toHaveLength(2);
		await expect(applyPiImport(plan)).rejects.toThrow("conflict");
		expect(existsSync(join(options.destinationAgentDir, "settings.json"))).toBe(false);
	});

	it("skip policy keeps only the first stable same-name selection", async () => {
		const plan = await inventoryPiImport({ ...duplicateSources(), onConflict: "skip" });
		const receipt = await applyPiImport(plan);
		await activatePiImport(receipt.id, options.destinationAgentDir);
		const settings = JSON.parse(readFileSync(join(options.destinationAgentDir, "settings.json"), "utf8"));
		expect(settings.extensions).toHaveLength(1);
		expect(readFileSync(settings.extensions[0], "utf8")).toContain("// project");
		const repeated = await applyPiImport(await inventoryPiImport({ ...duplicateSources(), onConflict: "skip" }));
		expect(repeated.id).toBe(receipt.id);
		await activatePiImport(repeated.id, options.destinationAgentDir);
		expect(
			JSON.parse(readFileSync(join(options.destinationAgentDir, "settings.json"), "utf8")).extensions,
		).toHaveLength(1);
	});

	it("activation also rejects older generations containing same-batch duplicates", async () => {
		const stage = await stagePiImport(await inventoryPiImport(duplicateSources()));
		mkdirSync(join(options.destinationAgentDir, "imports", "pi", "generations"), { recursive: true });
		renameSync(stage.stagingDir, join(options.destinationAgentDir, stage.generationRelativePath));
		publishReceipt(options.destinationAgentDir, {
			id: stage.manifestSha256,
			generationRelativePath: stage.generationRelativePath,
			manifestSha256: stage.manifestSha256,
			onConflict: "error",
		});
		await expect(activatePiImport(stage.manifestSha256, options.destinationAgentDir)).rejects.toThrow("conflict");
		expect(existsSync(join(options.destinationAgentDir, "settings.json"))).toBe(false);
	});

	it("repeat identical import is idempotent", async () => {
		const first = await applyPiImport(await inventoryPiImport(options));
		await activatePiImport(first.id, options.destinationAgentDir);
		const second = await applyPiImport(await inventoryPiImport(options));
		expect(second.id).toBe(first.id);
		expect(second.status).toBe("already-imported");
		await activatePiImport(second.id, options.destinationAgentDir);
		expect(
			JSON.parse(readFileSync(join(options.destinationAgentDir, "settings.json"), "utf8")).extensions,
		).toHaveLength(1);
	});

	it("activation requires unchanged hashes", async () => {
		const plan = await inventoryPiImport(options);
		const receipt = await applyPiImport(plan);
		writeFileSync(
			join(options.destinationAgentDir, receipt.generationRelativePath, plan.resources[0]!.destinationRelativePath),
			"tampered",
		);
		await expect(activatePiImport(receipt.id, options.destinationAgentDir)).rejects.toThrow("hash");
	});

	it("activation refuses FIFO manifests without blocking", async ({ skip }) => {
		if (process.platform !== "linux") {
			skip("FIFO fixture requires Linux");
			return;
		}
		const receipt = await applyPiImport(await inventoryPiImport(options));
		const manifest = join(options.destinationAgentDir, receipt.generationRelativePath, "manifest.json");
		rmSync(manifest);
		execFileSync("mkfifo", [manifest]);
		const script = join(root, "activate.mjs");
		writeFileSync(
			script,
			`import { activatePiImport } from ${JSON.stringify(new URL("../src/core/pi-import/transaction.ts", import.meta.url).href)}; try { await activatePiImport(${JSON.stringify(receipt.id)}, ${JSON.stringify(options.destinationAgentDir)}); process.exitCode = 2; } catch { console.log("rejected safely"); }`,
		);
		const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 1000, killSignal: "SIGKILL" });
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("rejected safely");
	});

	it("concurrent settings update is not overwritten", async () => {
		const receipt = await applyPiImport(await inventoryPiImport(options));
		const manager = SettingsManager.create(root, options.destinationAgentDir);
		manager.setTheme("light");
		await manager.flush();
		await activatePiImport(receipt.id, options.destinationAgentDir);
		const settings = JSON.parse(readFileSync(join(options.destinationAgentDir, "settings.json"), "utf8"));
		expect(settings.theme).toBe("light");
		expect(settings.defaultModel).toBe("new-model");
	});
});
