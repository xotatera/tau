import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inventoryPiImport } from "../src/core/pi-import/inventory.ts";
import { recoverPiImports } from "../src/core/pi-import/recovery.ts";
import * as storage from "../src/core/pi-import/storage.ts";
import { activatePiImport, applyPiImport } from "../src/core/pi-import/transaction.ts";
import type { ImportOptions, JournalState } from "../src/core/pi-import/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { FileSettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

describe("Pi import crash recovery", () => {
	let root: string;
	let options: ImportOptions;
	let sourceBytes: Buffer;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tau-import-recovery-"));
		options = {
			sourceAgentDir: join(root, "pi"),
			destinationAgentDir: join(root, "tau"),
			preferences: false,
			onConflict: "error",
		};
		mkdirSync(join(options.sourceAgentDir, "extensions"), { recursive: true });
		mkdirSync(options.destinationAgentDir);
		sourceBytes = Buffer.from("export default function() {}");
		writeFileSync(join(options.sourceAgentDir, "extensions", "probe.ts"), sourceBytes);
		writeFileSync(join(options.destinationAgentDir, "settings.json"), '{"theme":"dark"}');
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	function crashAfter(state: JournalState): void {
		const original = storage.atomicWrite;
		vi.spyOn(storage, "atomicWrite").mockImplementation((path, data) => {
			original(path, data);
			if (path.endsWith("/journal.json") && JSON.parse(data.toString()).state === state)
				throw new Error("injected crash");
		});
	}
	for (const state of ["staged", "generation-published", "complete"] as const) {
		it(`recovers import publication after ${state}`, async () => {
			const plan = await inventoryPiImport(options);
			crashAfter(state);
			await expect(applyPiImport(plan)).rejects.toThrow("injected crash");
			vi.restoreAllMocks();
			const journal = join(storage.importRoot(options.destinationAgentDir), "journal.json");
			const before = readFileSync(journal);
			const dry = await inventoryPiImport(options);
			expect(dry.diagnostics).toContainEqual(expect.objectContaining({ code: "pending-journal" }));
			expect(readFileSync(journal)).toEqual(before);
			await recoverPiImports(options.destinationAgentDir);
			expect(existsSync(journal)).toBe(false);
			expect(JSON.parse(readFileSync(join(options.destinationAgentDir, "settings.json"), "utf8"))).toEqual({
				theme: "dark",
			});
			const receipt = await applyPiImport(await inventoryPiImport(options));
			expect(receipt.status).toBe("already-imported");
			expect(readFileSync(join(options.sourceAgentDir, "extensions", "probe.ts"))).toEqual(sourceBytes);
		});
	}
	for (const state of ["settings-prepared", "settings-published", "complete"] as const) {
		it(`recovers activation after ${state}`, async () => {
			const receipt = await applyPiImport(await inventoryPiImport(options));
			crashAfter(state);
			await expect(activatePiImport(receipt.id, options.destinationAgentDir)).rejects.toThrow("injected crash");
			vi.restoreAllMocks();
			await recoverPiImports(options.destinationAgentDir);
			const settings = JSON.parse(readFileSync(join(options.destinationAgentDir, "settings.json"), "utf8"));
			expect(settings.theme).toBe("dark");
			expect(settings.extensions).toHaveLength(1);
			expect(readFileSync(join(options.sourceAgentDir, "extensions", "probe.ts"))).toEqual(sourceBytes);
		});
	}

	it("retrying the reviewed apply recovers its pending import journal", async () => {
		const plan = await inventoryPiImport(options);
		crashAfter("staged");
		await expect(applyPiImport(plan)).rejects.toThrow("injected crash");
		vi.restoreAllMocks();
		const pending = await inventoryPiImport(options);
		expect(pending.diagnostics).toContainEqual(expect.objectContaining({ code: "pending-journal" }));
		expect(pending.id).toBe(plan.id);
		const receipt = await applyPiImport(plan);
		expect(receipt.status).toMatch(/inactive|already-imported/);
		expect(existsSync(join(storage.importRoot(options.destinationAgentDir), "journal.json"))).toBe(false);
	});

	it("never restores stale settings over a newer writer", async () => {
		const receipt = await applyPiImport(await inventoryPiImport(options));
		crashAfter("settings-prepared");
		await expect(activatePiImport(receipt.id, options.destinationAgentDir)).rejects.toThrow();
		vi.restoreAllMocks();
		const manager = SettingsManager.create(root, options.destinationAgentDir);
		manager.setTheme("light");
		await manager.flush();
		await recoverPiImports(options.destinationAgentDir);
		expect(JSON.parse(readFileSync(join(options.destinationAgentDir, "settings.json"), "utf8"))).toEqual({
			theme: "light",
		});
	});

	it("rejects corrupt journals and unowned cleanup targets", async () => {
		const receipt = await applyPiImport(await inventoryPiImport(options));
		const foreign = join(root, "foreign");
		mkdirSync(foreign);
		writeFileSync(join(foreign, "sentinel"), "must survive");
		const path = join(storage.importRoot(options.destinationAgentDir), "journal.json");
		writeFileSync(
			path,
			JSON.stringify({
				owner: storage.OWNER,
				operation: "import",
				state: "staged",
				id: receipt.id,
				manifestSha256: receipt.id,
				generationRelativePath: receipt.generationRelativePath,
				onConflict: "error",
				stagingRelativePath: "../foreign",
			}),
		);
		await expect(recoverPiImports(options.destinationAgentDir)).rejects.toThrow("journal");
		expect(readFileSync(join(foreign, "sentinel"), "utf8")).toBe("must survive");
		expect(existsSync(path)).toBe(true);
	});

	it("blocks SDK resource discovery before user code when a journal is corrupt", async () => {
		const imports = storage.importRoot(options.destinationAgentDir);
		mkdirSync(imports, { recursive: true });
		writeFileSync(join(imports, "journal.json"), "{");
		const marker = join(root, "executed");
		mkdirSync(join(options.destinationAgentDir, "extensions"));
		writeFileSync(
			join(options.destinationAgentDir, "extensions", "user.ts"),
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "unsafe"); export default function() {}`,
		);
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: options.destinationAgentDir });
		await expect(loader.reload()).rejects.toThrow("metadata");
		expect(existsSync(marker)).toBe(false);
	});

	it("fails closed on generation corruption during recovery", async () => {
		const plan = await inventoryPiImport(options);
		crashAfter("generation-published");
		await expect(applyPiImport(plan)).rejects.toThrow();
		vi.restoreAllMocks();
		const journal = JSON.parse(
			readFileSync(join(storage.importRoot(options.destinationAgentDir), "journal.json"), "utf8"),
		);
		writeFileSync(
			join(options.destinationAgentDir, journal.generationRelativePath, plan.resources[0]!.destinationRelativePath),
			"corrupt",
		);
		await expect(recoverPiImports(options.destinationAgentDir)).rejects.toThrow("hash");
		expect(JSON.parse(readFileSync(join(options.destinationAgentDir, "settings.json"), "utf8"))).toEqual({
			theme: "dark",
		});
	});

	it("disk-full failure leaves old usable settings and no unowned cleanup", async () => {
		const original = storage.durableWrite;
		vi.spyOn(storage, "durableWrite").mockImplementation((path, data, mode) => {
			if (path.endsWith("manifest.json")) throw new Error("ENOSPC");
			original(path, data, mode);
		});
		await expect(applyPiImport(await inventoryPiImport(options))).rejects.toThrow("ENOSPC");
		vi.restoreAllMocks();
		await recoverPiImports(options.destinationAgentDir);
		expect(JSON.parse(readFileSync(join(options.destinationAgentDir, "settings.json"), "utf8"))).toEqual({
			theme: "dark",
		});
		expect(readFileSync(join(options.sourceAgentDir, "extensions", "probe.ts"))).toEqual(sourceBytes);
	});

	it("permission failure before settings publication preserves old usable settings", async () => {
		const receipt = await applyPiImport(await inventoryPiImport(options));
		const original = storage.durableWrite;
		vi.spyOn(storage, "durableWrite").mockImplementation((path, data, mode) => {
			if (path.includes(".pi-import-settings-")) throw new Error("EACCES");
			original(path, data, mode);
		});
		await expect(activatePiImport(receipt.id, options.destinationAgentDir)).rejects.toThrow("EACCES");
		vi.restoreAllMocks();
		await recoverPiImports(options.destinationAgentDir);
		expect(JSON.parse(readFileSync(join(options.destinationAgentDir, "settings.json"), "utf8"))).toEqual({
			theme: "dark",
		});
		expect(readFileSync(join(options.sourceAgentDir, "extensions", "probe.ts"))).toEqual(sourceBytes);
	});

	it("unavailable shared lock cannot overwrite settings", async () => {
		const plan = await inventoryPiImport(options);
		const release = storage.acquireSettingsLock(options.destinationAgentDir);
		try {
			await expect(applyPiImport(plan)).rejects.toThrow();
		} finally {
			release();
		}
		expect(JSON.parse(readFileSync(join(options.destinationAgentDir, "settings.json"), "utf8"))).toEqual({
			theme: "dark",
		});
	});

	it("ordinary settings writer detects a changed version before persistence", () => {
		const writer = new FileSettingsStorage(root, options.destinationAgentDir);
		expect(() =>
			writer.withLock("global", (current) => {
				writeFileSync(join(options.destinationAgentDir, "settings.json"), '{"theme":"newer"}');
				return JSON.stringify({ ...JSON.parse(current!), defaultModel: "stale-write" });
			}),
		).toThrow("changed");
		expect(JSON.parse(readFileSync(join(options.destinationAgentDir, "settings.json"), "utf8"))).toEqual({
			theme: "newer",
		});
	});

	it("ordinary writer acquires the import lock even before first settings publication", () => {
		rmSync(join(options.destinationAgentDir, "settings.json"));
		const release = storage.acquireSettingsLock(options.destinationAgentDir);
		let callbackRan = false;
		try {
			const writer = new FileSettingsStorage(root, options.destinationAgentDir);
			expect(() =>
				writer.withLock("global", () => {
					callbackRan = true;
					return '{"theme":"light"}';
				}),
			).toThrow();
			expect(callbackRan).toBe(false);
		} finally {
			release();
		}
	});
});
