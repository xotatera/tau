import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getUpdateInstruction,
	VERSION,
} from "../src/config.ts";
import { main } from "../src/main.ts";
import { cleanupManagedInstall, handlePackageCommand } from "../src/package-manager-cli.ts";
import * as childProcesses from "../src/utils/child-process.ts";
import { checkForNewPiVersion, getLatestPiRelease } from "../src/utils/version-check.ts";
import * as windowsUpdate from "../src/utils/windows-self-update.ts";

const unavailable =
	"Automatic Tau updates are unavailable in this source-only fork. Update your Tau source checkout from https://github.com/xotatera/tau.";

// Deny external processes at the boundary: an unsafe updater cannot actually install anything in RED runs.
vi.mock("../src/utils/child-process.ts", async (importOriginal) => ({
	...(await importOriginal<typeof childProcesses>()),
	spawnProcess: vi.fn(() => {
		throw new Error("unexpected updater child process");
	}),
	spawnProcessSync: vi.fn(() => {
		throw new Error("unexpected updater child process");
	}),
}));

function snapshot(directory: string): Record<string, string> {
	const files: Record<string, string> = {};
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			for (const [child, content] of Object.entries(snapshot(path))) files[`${entry.name}/${child}`] = content;
		} else files[entry.name] = readFileSync(path).toString("base64");
	}
	return files;
}

describe("Tau source-only update policy", () => {
	let root: string;
	let managedRoot: string;
	let agentDir: string;
	let originalCwd: string;
	let originalExitCode: typeof process.exitCode;
	let fetchMock: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		vi.clearAllMocks();
		root = mkdtempSync(join(tmpdir(), "tau-update-policy-"));
		managedRoot = join(root, "pi-managed");
		agentDir = join(root, ".tau", "agent");
		const release = join(managedRoot, "releases", VERSION, "node_modules", "@earendil-works", "pi-coding-agent");
		mkdirSync(release, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(managedRoot, "staging", "update-must-survive"), { recursive: true });
		writeFileSync(join(managedRoot, "staging", "update-must-survive", "sentinel"), "Pi staging state");
		writeFileSync(
			join(release, "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: VERSION }),
		);
		writeFileSync(
			join(managedRoot, "managed-install.json"),
			JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" }),
		);
		writeFileSync(join(managedRoot, "current-version"), VERSION);
		originalCwd = process.cwd();
		originalExitCode = process.exitCode;
		process.chdir(root);
		process.exitCode = undefined;
		vi.stubEnv("TAU_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_MANAGED_INSTALL_ROOT", managedRoot);
		vi.stubEnv("PI_PACKAGE_DIR", release);
		vi.stubEnv("PI_OFFLINE", "");
		vi.stubEnv("PI_SKIP_VERSION_CHECK", "");
		fetchMock = vi.fn(async () =>
			Response.json({ packageName: "@earendil-works/pi-coding-agent", version: "999.0.0" }),
		);
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		rmSync(root, { recursive: true, force: true });
	});

	it("Tau cannot self-update into Pi", () => {
		for (const layout of [root, process.env.PI_PACKAGE_DIR!]) {
			vi.stubEnv("PI_PACKAGE_DIR", layout);
			expect(
				getSelfUpdateCommand("@xotatera/tau-coding-agent", ["npm"], "@earendil-works/pi-coding-agent"),
			).toBeUndefined();
			expect(getSelfUpdateUnavailableInstruction("@xotatera/tau-coding-agent")).toBe(unavailable);
			expect(getUpdateInstruction("@xotatera/tau-coding-agent")).toBe(unavailable);
		}
		expect(childProcesses.spawnProcessSync).not.toHaveBeenCalled();
	});

	it("Tau version check performs no fetch", async () => {
		await expect(checkForNewPiVersion(VERSION)).resolves.toBeUndefined();
		await expect(getLatestPiRelease(VERSION, { retry: true })).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	for (const target of [[], ["self"], ["pi"], ["tau"], ["--self"], ["--self", "--force"]]) {
		it(`blocks update ${target.join(" ")} before transports, installers, or managed-root mutation`, async () => {
			const before = snapshot(managedRoot);
			expect(await handlePackageCommand(["update", ...target])).toBe(true);
			expect(process.exitCode).toBe(1);
			expect(console.error).toHaveBeenCalledWith(unavailable);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(childProcesses.spawnProcess).not.toHaveBeenCalled();
			expect(childProcesses.spawnProcessSync).not.toHaveBeenCalled();
			expect(snapshot(managedRoot)).toEqual(before);
		});
	}

	it("does not clean inherited Pi managed staging", () => {
		const before = snapshot(managedRoot);
		cleanupManagedInstall();
		expect(snapshot(managedRoot)).toEqual(before);
	});

	it("keeps extension-only updates available", async () => {
		const packagePath = join(root, "local-extension");
		mkdirSync(packagePath);
		writeFileSync(
			join(packagePath, "package.json"),
			JSON.stringify({ name: "local-extension", pi: { extensions: ["index.ts"] } }),
		);
		writeFileSync(join(packagePath, "index.ts"), "export default function() {}");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packagePath] }));
		const before = snapshot(managedRoot);
		expect(await handlePackageCommand(["update", "--extension", packagePath])).toBe(true);
		expect(process.exitCode ?? 0).toBe(0);
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`Updated ${packagePath}`));
		expect(fetchMock).not.toHaveBeenCalled();
		expect(snapshot(managedRoot)).toEqual(before);
	});

	it("reports completed extension updates but returns failure for --all", async () => {
		const packagePath = join(root, "local-extension");
		mkdirSync(packagePath);
		writeFileSync(
			join(packagePath, "package.json"),
			JSON.stringify({ name: "local-extension", pi: { extensions: ["index.ts"] } }),
		);
		writeFileSync(join(packagePath, "index.ts"), "export default function() {}");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packagePath] }));
		const before = snapshot(managedRoot);
		expect(await handlePackageCommand(["update", "--all"])).toBe(true);
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Updated packages"));
		expect(console.error).toHaveBeenCalledWith(unavailable);
		expect(process.exitCode).toBe(1);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(childProcesses.spawnProcess).not.toHaveBeenCalled();
		expect(snapshot(managedRoot)).toEqual(before);
	});

	it("does not clean Pi Windows quarantine from the Tau launcher", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
		const cleanup = vi.spyOn(windowsUpdate, "cleanupWindowsSelfUpdateQuarantine").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("command exited");
		});
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			await expect(main(["update"])).rejects.toThrow("command exited");
			expect(cleanup).not.toHaveBeenCalled();
		} finally {
			Object.defineProperty(process, "platform", descriptor);
		}
	});
});
