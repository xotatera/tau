import { execFileSync, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inventoryPiImport } from "../src/core/pi-import/inventory.ts";
import { applyPiImport } from "../src/core/pi-import/transaction.ts";
import type { ImportOptions } from "../src/core/pi-import/types.ts";

describe("Pi import independent snapshots", () => {
	let root: string;
	let options: ImportOptions;
	let packageRoot: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tau-import-snapshot-"));
		options = {
			sourceAgentDir: join(root, "pi"),
			destinationAgentDir: join(root, "tau"),
			preferences: false,
			onConflict: "error",
		};
		packageRoot = join(options.sourceAgentDir, "extensions", "package");
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({ name: "legacy", version: "1.0.0", pi: { extensions: ["index.ts"] } }),
		);
		writeFileSync(
			join(packageRoot, "index.ts"),
			"export default function(pi) { pi.registerCommand('imported', { handler: async () => {} }); }",
		);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("records available git provenance without copying git metadata", async () => {
		const commit = "a".repeat(40);
		mkdirSync(join(packageRoot, ".git"));
		writeFileSync(join(packageRoot, ".git", "HEAD"), `${commit}\n`);
		const plan = await inventoryPiImport(options);
		expect(plan.resources[0]!.resolvedCommit).toBe(commit);
		const receipt = await applyPiImport(plan);
		expect(
			existsSync(
				join(
					options.destinationAgentDir,
					receipt.generationRelativePath,
					plan.resources[0]!.destinationRelativePath,
					".git",
				),
			),
		).toBe(false);
	});

	it("independent copies survive source removal", async () => {
		const plan = await inventoryPiImport(options);
		const source = readFileSync(join(packageRoot, "index.ts"));
		const inode = statSync(join(packageRoot, "index.ts")).ino;
		const receipt = await applyPiImport(plan);
		const path = join(
			options.destinationAgentDir,
			receipt.generationRelativePath,
			plan.resources[0]!.destinationRelativePath,
			"index.ts",
		);
		expect(receipt.status).toBe("inactive");
		expect(readFileSync(path)).toEqual(source);
		expect(statSync(path).ino).not.toBe(inode);
		expect(existsSync(join(options.destinationAgentDir, "settings.json"))).toBe(false);
		rmSync(options.sourceAgentDir, { recursive: true });
		expect(readFileSync(path)).toEqual(source);
	});

	it("materializes contained symlinks", async () => {
		writeFileSync(join(packageRoot, "support.txt"), "support");
		symlinkSync("support.txt", join(packageRoot, "alias.txt"));
		const plan = await inventoryPiImport(options);
		const receipt = await applyPiImport(plan);
		const path = join(
			options.destinationAgentDir,
			receipt.generationRelativePath,
			plan.resources[0]!.destinationRelativePath,
			"alias.txt",
		);
		expect(readFileSync(path, "utf8")).toBe("support");
		expect(statSync(path).nlink).toBe(1);
		rmSync(options.sourceAgentDir, { recursive: true });
		expect(readFileSync(path, "utf8")).toBe("support");
	});

	it("rejects escaping links and cycles", async () => {
		writeFileSync(join(root, "outside"), "not selected");
		symlinkSync(join(root, "outside"), join(packageRoot, "escape"));
		let plan = await inventoryPiImport(options);
		await expect(applyPiImport(plan)).rejects.toThrow();
		expect(existsSync(options.destinationAgentDir)).toBe(false);
		rmSync(join(packageRoot, "escape"));
		symlinkSync(".", join(packageRoot, "cycle"));
		plan = await inventoryPiImport(options);
		expect(plan.diagnostics).toContainEqual(
			expect.objectContaining({ severity: "error", message: expect.stringContaining("cycle") }),
		);
	});

	it("rejects special files and overlapping roots", async ({ skip }) => {
		if (process.platform !== "linux") {
			skip("FIFO fixture requires Linux");
			return;
		}
		execFileSync("mkfifo", [join(packageRoot, "pipe")]);
		const plan = await inventoryPiImport(options);
		expect(plan.diagnostics).toContainEqual(
			expect.objectContaining({ severity: "error", message: expect.stringContaining("unsupported file") }),
		);
		const overlap = await inventoryPiImport({ ...options, destinationAgentDir: join(packageRoot, "tau") });
		expect(overlap.diagnostics).toContainEqual(expect.objectContaining({ code: "overlapping-roots" }));
	});

	it("source mutation invalidates apply", async () => {
		const plan = await inventoryPiImport(options);
		writeFileSync(join(packageRoot, "index.ts"), "changed after review");
		await expect(applyPiImport(plan)).rejects.toThrow("review");
		expect(existsSync(options.destinationAgentDir)).toBe(false);
	});

	it("a changed canonical resource root invalidates approval even with identical bytes", async () => {
		const plan = await inventoryPiImport(options);
		const other = join(root, "other-package");
		cpSync(packageRoot, other, { recursive: true });
		renameSync(packageRoot, join(root, "old-package"));
		symlinkSync(other, packageRoot, "dir");
		await expect(applyPiImport(plan)).rejects.toThrow("review");
		expect(existsSync(options.destinationAgentDir)).toBe(false);
	});

	it("a source changed to a FIFO during copying cannot block apply", ({ skip }) => {
		if (process.platform !== "linux") {
			skip("FIFO fixture requires Linux");
			return;
		}
		const script = join(root, "source-race.mjs");
		const file = join(packageRoot, "index.ts");
		writeFileSync(
			script,
			`import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { inventoryPiImport } from ${JSON.stringify(new URL("../src/core/pi-import/inventory.ts", import.meta.url).href)};
import { applyPiImport } from ${JSON.stringify(new URL("../src/core/pi-import/transaction.ts", import.meta.url).href)};
const options = ${JSON.stringify(options)};
const plan = await inventoryPiImport(options);
const original = fs.realpathSync;
let changed = false;
fs.realpathSync = function(path, ...args) {
  const result = original(path, ...args);
  if (!changed && path === ${JSON.stringify(file)} && fs.existsSync(options.destinationAgentDir + "/imports/pi/staging")) {
    changed = true; fs.unlinkSync(path); execFileSync("mkfifo", [path]);
  }
  return result;
};
syncBuiltinESMExports();
try { await applyPiImport(plan); process.exitCode = 2; } catch { console.log("rejected safely"); }
`,
		);
		const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 1500, killSignal: "SIGKILL" });
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("rejected safely");
	});

	it("missing dependencies block selection", async () => {
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({ pi: { extensions: ["index.ts"] }, dependencies: { missing: "1.0.0" } }),
		);
		const plan = await inventoryPiImport(options);
		expect(plan.diagnostics).toContainEqual(expect.objectContaining({ severity: "error" }));
		await expect(applyPiImport(plan)).rejects.toThrow();
		expect(existsSync(options.destinationAgentDir)).toBe(false);
	});

	it("rebases an explicitly selected local theme preference", async () => {
		const theme = join(options.sourceAgentDir, "themes", "custom.json");
		mkdirSync(join(options.sourceAgentDir, "themes"));
		writeFileSync(theme, JSON.stringify({ name: "custom" }));
		writeFileSync(join(options.sourceAgentDir, "settings.json"), JSON.stringify({ theme }));
		const plan = await inventoryPiImport({ ...options, preferences: true });
		const receipt = await applyPiImport(plan);
		const preferences = readFileSync(
			join(options.destinationAgentDir, receipt.generationRelativePath, "preferences.json"),
			"utf8",
		);
		expect(JSON.parse(preferences).theme).toBe("custom");
		expect(preferences).not.toContain(options.sourceAgentDir);
	});

	it("excludes recursive secrets and blocks entrypoints requiring them", async () => {
		writeFileSync(join(packageRoot, ".env"), "SECRET=synthetic-secret");
		const plan = await inventoryPiImport(options);
		const receipt = await applyPiImport(plan);
		expect(
			existsSync(
				join(
					options.destinationAgentDir,
					receipt.generationRelativePath,
					plan.resources[0]!.destinationRelativePath,
					".env",
				),
			),
		).toBe(false);
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ pi: { extensions: [".env"] } }));
		expect((await inventoryPiImport(options)).diagnostics).toContainEqual(
			expect.objectContaining({ severity: "error" }),
		);
	});
});
