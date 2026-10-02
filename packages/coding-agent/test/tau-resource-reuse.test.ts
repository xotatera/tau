import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

const packageFixture = fileURLToPath(new URL("fixtures/tau-compat/package/", import.meta.url));

describe("Tau explicit Pi resource reuse", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tau-reuse-"));
		cwd = join(root, "project with spaces #");
		agentDir = join(root, ".tau", "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function extension(path: string): string {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			'export default function(pi) { pi.registerCommand("reused", { description: "Pi resource", handler: async () => {} }); }',
		);
		return path;
	}

	it("does not discover ambient Pi user or project extensions", async () => {
		extension(join(cwd, ".pi", "extensions", "project.ts"));
		extension(join(root, ".pi", "agent", "extensions", "user.ts"));
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();
		expect(loader.getExtensions().extensions).toEqual([]);
		expect(loader.getExtensions().errors).toEqual([]);
	});

	for (const selection of ["file", "directory", "relative"]) {
		it(`reuses an explicitly selected Pi ${selection} without changing its source`, async () => {
			const path = extension(join(cwd, ".pi", "extensions", selection === "directory" ? "index.ts" : "selected.ts"));
			const source = readFileSync(path);
			const selected =
				selection === "file" ? path : selection === "directory" ? dirname(path) : ".pi/extensions/selected.ts";
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				additionalExtensionPaths: [selected],
				settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
			});
			await loader.reload();
			expect(loader.getExtensions().errors).toEqual([]);
			expect(loader.getExtensions().extensions).toHaveLength(1);
			expect(loader.getExtensions().extensions[0]?.commands.has("reused")).toBe(true);
			expect(readFileSync(path)).toEqual(source);
		});
	}

	it("reuses a Pi file explicitly configured in Tau user settings", async () => {
		const path = extension(join(root, ".pi", "agent", "extensions", "user.ts"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [path] }));
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions[0]?.commands.has("reused")).toBe(true);
	});

	it("uses the unchanged pi.extensions manifest and only its declared entrypoint", async () => {
		const packageRoot = join(cwd, ".pi", "legacy package");
		cpSync(packageFixture, packageRoot, { recursive: true });
		writeFileSync(join(packageRoot, "not-an-entry.ts"), 'throw new Error("undeclared file executed");');
		const loader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [packageRoot] });
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions).toHaveLength(1);
		expect(loader.getExtensions().extensions[0]?.commands.has("legacy-package")).toBe(true);
	});

	it("blocks Tau project extensions when trust is denied despite Pi saved trust", async () => {
		const piAgentDir = join(root, ".pi", "agent");
		new ProjectTrustStore(piAgentDir).set(cwd, true);
		const piTrust = readFileSync(join(piAgentDir, "trust.json"));
		extension(join(cwd, ".tau", "extensions", "project.ts"));
		const tauStore = new ProjectTrustStore(agentDir);
		expect(tauStore.get(cwd)).toBeNull();
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
		});
		await loader.reload();
		expect(loader.getExtensions().extensions).toEqual([]);
		expect(readFileSync(join(piAgentDir, "trust.json"))).toEqual(piTrust);
	});

	it("deduplicates symlink-equivalent explicit Pi paths", async ({ skip }) => {
		const path = extension(join(cwd, ".pi", "extensions", "selected.ts"));
		const alias = join(cwd, "alias.ts");
		try {
			symlinkSync(path, alias);
		} catch (error) {
			if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") {
				skip("Windows denied symlink creation");
				return;
			}
			throw error;
		}
		const loader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [path, alias] });
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions).toHaveLength(1);
	});

	it("reports a missing explicitly selected Pi path", async () => {
		const path = join(cwd, ".pi", "missing.ts");
		const loader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [path] });
		await loader.reload();
		expect(loader.getExtensions().extensions).toEqual([]);
		expect(loader.getExtensions().errors).toContainEqual({ path, error: `Extension path does not exist: ${path}` });
	});

	it("rejects a malformed explicitly selected package manifest", async () => {
		const packageRoot = join(cwd, ".pi", "invalid-package");
		extension(join(packageRoot, "index.ts"));
		writeFileSync(join(packageRoot, "package.json"), "{");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }),
		});
		await expect(loader.reload()).rejects.toThrow(SyntaxError);
	});

	it("warns about a physical Tau host dependency in a reused package", async () => {
		const packageRoot = join(cwd, ".pi", "duplicate-host");
		extension(join(packageRoot, "index.ts"));
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({
				pi: { extensions: ["./index.ts"] },
				dependencies: { "@xotatera/tau-coding-agent": "1.0.0" },
			}),
		);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }),
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().warnings).toEqual([
			{
				path: join(packageRoot, "package.json"),
				warning:
					'Host-provided extension packages must be declared in peerDependencies with a "*" range, not dependencies: @xotatera/tau-coding-agent. Installed copies can bypass the extension loader and create duplicate runtime modules.',
			},
		]);
	});
});
