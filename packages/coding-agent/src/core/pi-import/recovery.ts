import { existsSync, lstatSync, renameSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { canonical, contained, hash, isObject, readObject, readRegularFile } from "./inventory.ts";
import { generationPath, validateGeneration } from "./snapshot.ts";
import {
	acquireSettingsLock,
	atomicWrite,
	ensureDirectory,
	importRoot,
	OWNER,
	rawSettingsHash,
	syncDirectory,
} from "./storage.ts";
import type { ConflictPolicy, JournalState } from "./types.ts";

export interface ImportJournal {
	owner: typeof OWNER;
	operation: "import" | "activate";
	state: JournalState;
	id: string;
	generationRelativePath: string;
	manifestSha256: string;
	onConflict: ConflictPolicy;
	stagingRelativePath?: string;
	baseSettingsSha256?: string;
	nextSettingsSha256?: string;
	nextSettingsFile?: string;
}
export function writeJournal(agentDir: string, journal: ImportJournal): void {
	atomicWrite(join(importRoot(agentDir), "journal.json"), JSON.stringify(journal));
}
export function removeOwnedStage(agentDir: string, stagingRelativePath: string, manifestSha256: string): void {
	if (!/^imports\/pi\/staging\/[a-f0-9-]{36}$/.test(stagingRelativePath))
		throw new Error("Unsafe staging cleanup reference");
	const path = join(agentDir, stagingRelativePath);
	if (!existsSync(path)) return;
	if (
		!contained(canonical(agentDir), canonical(path)) ||
		!lstatSync(path).isDirectory() ||
		lstatSync(path).isSymbolicLink()
	)
		throw new Error("Unsafe staging cleanup target");
	const marker = readObject(join(path, "owner.json"));
	if (marker.owner !== OWNER || marker.manifestSha256 !== manifestSha256)
		throw new Error("Staging ownership mismatch");
	rmSync(path, { recursive: true });
	syncDirectory(join(importRoot(agentDir), "staging"));
}
function parseJournal(value: unknown): ImportJournal {
	if (
		!isObject(value) ||
		value.owner !== OWNER ||
		!["import", "activate"].includes(String(value.operation)) ||
		!["staged", "generation-published", "settings-prepared", "settings-published", "complete"].includes(
			String(value.state),
		) ||
		typeof value.id !== "string" ||
		typeof value.manifestSha256 !== "string" ||
		value.id !== value.manifestSha256 ||
		value.generationRelativePath !== generationPath(value.id) ||
		!["error", "skip"].includes(String(value.onConflict))
	)
		throw new Error("Corrupt import journal; refusing recovery");
	if (value.operation === "import") {
		if (
			typeof value.stagingRelativePath !== "string" ||
			!/^imports\/pi\/staging\/[a-f0-9-]{36}$/.test(value.stagingRelativePath)
		)
			throw new Error("Corrupt staging journal reference");
	} else {
		if (
			typeof value.baseSettingsSha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.baseSettingsSha256) ||
			typeof value.nextSettingsSha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.nextSettingsSha256) ||
			typeof value.nextSettingsFile !== "string" ||
			!new RegExp(`^\\.pi-import-settings-${value.id}-[a-f0-9-]{36}\\.json$`).test(value.nextSettingsFile)
		)
			throw new Error("Corrupt settings journal reference");
	}
	return value as unknown as ImportJournal;
}
export function publishReceipt(
	agentDir: string,
	journal: Pick<ImportJournal, "id" | "generationRelativePath" | "manifestSha256" | "onConflict">,
): void {
	ensureDirectory(agentDir, "imports/pi/receipts");
	const path = join(importRoot(agentDir), "receipts", `${journal.id}.json`);
	if (existsSync(path)) {
		const receipt = readObject(path);
		if (
			receipt.owner !== OWNER ||
			receipt.id !== journal.id ||
			receipt.manifestSha256 !== journal.manifestSha256 ||
			receipt.generationRelativePath !== journal.generationRelativePath
		)
			throw new Error("Existing import receipt is invalid");
		return;
	}
	atomicWrite(path, JSON.stringify({ owner: OWNER, schemaVersion: 1, ...journal }));
}
export function recoverLocked(agentDir: string): void {
	const path = join(importRoot(agentDir), "journal.json");
	if (!existsSync(path)) return;
	const journal = parseJournal(readObject(path));
	const generation = join(agentDir, journal.generationRelativePath);
	if (journal.operation === "import") {
		const staging = join(agentDir, journal.stagingRelativePath!);
		if (!existsSync(generation)) {
			validateGeneration(agentDir, journal.stagingRelativePath!, journal.manifestSha256);
			ensureDirectory(agentDir, "imports/pi/generations");
			renameSync(staging, generation);
			syncDirectory(join(importRoot(agentDir), "generations"));
		}
		validateGeneration(agentDir, journal.generationRelativePath, journal.manifestSha256);
		removeOwnedStage(agentDir, journal.stagingRelativePath!, journal.manifestSha256);
		publishReceipt(agentDir, {
			id: journal.id,
			generationRelativePath: journal.generationRelativePath,
			manifestSha256: journal.manifestSha256,
			onConflict: journal.onConflict,
		});
	} else {
		validateGeneration(agentDir, journal.generationRelativePath, journal.manifestSha256);
		const temporary = join(agentDir, journal.nextSettingsFile!);
		const current = rawSettingsHash(agentDir);
		if (existsSync(temporary)) {
			if (!lstatSync(temporary).isFile() || hash(readRegularFile(temporary)) !== journal.nextSettingsSha256)
				throw new Error("Prepared settings hash mismatch; refusing recovery");
			readObject(temporary);
			if (current === journal.baseSettingsSha256) {
				renameSync(temporary, join(agentDir, "settings.json"));
				syncDirectory(agentDir);
			} else rmSync(temporary);
		}
		// Missing temp after rename, or a newer writer: retain the current settings; never restore a backup.
	}
	journal.state = "complete";
	writeJournal(agentDir, journal);
	rmSync(path);
	syncDirectory(importRoot(agentDir));
}
export async function recoverPiImports(agentDir: string): Promise<void> {
	if (!existsSync(join(importRoot(agentDir), "journal.json"))) return;
	// Validate structure before acquiring even a temporary lock; corrupted paths never guide cleanup.
	parseJournal(readObject(join(importRoot(agentDir), "journal.json")));
	const release = acquireSettingsLock(agentDir);
	try {
		recoverLocked(agentDir);
	} finally {
		release();
	}
}
export function stageRelative(agentDir: string, stagingDir: string): string {
	return relative(agentDir, stagingDir).split(sep).join("/");
}
