import { randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { hash, isObject, readImportPreferences, readObject } from "./inventory.ts";
import {
	type ImportJournal,
	publishReceipt,
	recoverLocked,
	recoverPiImports,
	removeOwnedStage,
	stageRelative,
	writeJournal,
} from "./recovery.ts";
import { describeSnapshot, generationPath, reviewedPlan, stageLocked, validateGeneration } from "./snapshot.ts";
import {
	acquireSettingsLock,
	durableWrite,
	ensureDirectory,
	importRoot,
	OWNER,
	rawSettingsHash,
	syncDirectory,
} from "./storage.ts";
import type { ConflictPolicy, GenerationManifest, ImportPlan, ImportPreferences, ImportReceipt } from "./types.ts";

const fields = {
	extension: "extensions",
	skill: "skills",
	prompt: "prompts",
	theme: "themes",
	package: "packages",
} as const;
function resourceConflict(
	agentDir: string,
	settings: Record<string, unknown>,
	kind: keyof typeof fields,
	name: string,
	ownPath?: string,
): boolean {
	const direct = join(agentDir, fields[kind], name);
	if (existsSync(direct) && direct !== ownPath) return true;
	const entries = settings[fields[kind]];
	if (!Array.isArray(entries)) return false;
	return entries.some((entry) => {
		const path =
			typeof entry === "string"
				? entry
				: isObject(entry) && typeof entry.source === "string"
					? entry.source
					: undefined;
		return path !== undefined && path !== ownPath && basename(path) === name;
	});
}
export async function applyPiImport(input: ImportPlan): Promise<ImportReceipt> {
	// Invalid/stale reviewed plans cannot create a destination or lock.
	let plan = await reviewedPlan(input, true);
	await recoverPiImports(plan.options.destinationAgentDir);
	plan = await reviewedPlan(input);
	const agentDir = plan.options.destinationAgentDir;
	const release = acquireSettingsLock(agentDir);
	try {
		recoverLocked(agentDir);
		if (rawSettingsHash(agentDir) !== plan.baseSettingsSha256) throw new Error("Settings changed since review");
		const settings = readObject(join(agentDir, "settings.json"));
		const batchNames = new Set<string>();
		const batchResources = plan.resources.filter((resource) => {
			const name = basename(resource.relativePath === "." ? resource.sourceRoot : resource.relativePath);
			const key = `${resource.kind}:${name}`;
			if (batchNames.has(key)) {
				if (plan.options.onConflict === "error") throw new Error("Import resource conflict within selected batch");
				return false;
			}
			batchNames.add(key);
			return true;
		});
		const candidate = await describeSnapshot(
			{ ...plan, resources: batchResources },
			await readImportPreferences(plan.options),
		);
		const preferences: ImportPreferences = JSON.parse(candidate.preferencesData);
		const candidatePath = generationPath(candidate.manifestSha256);
		if (existsSync(join(agentDir, candidatePath))) {
			validateGeneration(agentDir, candidatePath, candidate.manifestSha256);
			publishReceipt(agentDir, {
				id: candidate.manifestSha256,
				generationRelativePath: candidatePath,
				manifestSha256: candidate.manifestSha256,
				onConflict: plan.options.onConflict,
			});
			return {
				id: candidate.manifestSha256,
				generationRelativePath: candidatePath,
				manifestSha256: candidate.manifestSha256,
				status: "already-imported",
			};
		}
		const resources = batchResources.filter((resource) => {
			const name = basename(resource.relativePath === "." ? resource.sourceRoot : resource.relativePath);
			const conflict = resourceConflict(agentDir, settings, resource.kind, name);
			if (conflict && plan.options.onConflict === "error") throw new Error("Import resource conflict");
			return !conflict;
		});
		for (const key of Object.keys(preferences) as Array<keyof ImportPreferences>) {
			if (settings[key] !== undefined && settings[key] !== preferences[key]) {
				if (plan.options.onConflict === "error") throw new Error("Import preference conflict");
				delete preferences[key];
			}
		}
		const stage = await stageLocked({ ...plan, resources }, preferences);
		const id = stage.manifestSha256;
		const journal: ImportJournal = {
			owner: OWNER,
			operation: "import",
			state: "staged",
			id,
			generationRelativePath: stage.generationRelativePath,
			manifestSha256: stage.manifestSha256,
			onConflict: plan.options.onConflict,
			stagingRelativePath: stageRelative(agentDir, stage.stagingDir),
		};
		const target = join(agentDir, journal.generationRelativePath);
		const already = existsSync(target);
		writeJournal(agentDir, journal);
		ensureDirectory(agentDir, "imports/pi/generations");
		if (already) {
			validateGeneration(agentDir, journal.generationRelativePath, id);
			removeOwnedStage(agentDir, journal.stagingRelativePath!, id);
		} else {
			renameSync(stage.stagingDir, target);
			syncDirectory(join(importRoot(agentDir), "generations"));
		}
		journal.state = "generation-published";
		writeJournal(agentDir, journal);
		publishReceipt(agentDir, {
			id,
			generationRelativePath: journal.generationRelativePath,
			manifestSha256: id,
			onConflict: journal.onConflict,
		});
		journal.state = "complete";
		writeJournal(agentDir, journal);
		rmSync(join(importRoot(agentDir), "journal.json"));
		syncDirectory(importRoot(agentDir));
		return {
			id,
			generationRelativePath: journal.generationRelativePath,
			manifestSha256: id,
			status: already ? "already-imported" : "inactive",
		};
	} finally {
		release();
	}
}

function readGenerationPreferences(
	agentDir: string,
	generation: string,
	manifest: GenerationManifest,
): ImportPreferences {
	const value = readObject(join(agentDir, generation, "preferences.json"));
	if (
		Object.keys(value).some((key) => !manifest.preferenceKeys.includes(key as keyof ImportPreferences)) ||
		manifest.preferenceKeys.some((key) => typeof value[key] !== "string")
	)
		throw new Error("Invalid imported preferences");
	return value as ImportPreferences;
}
export async function activatePiImport(id: string, inputAgentDir: string): Promise<void> {
	const generation = generationPath(id);
	const agentDir = inputAgentDir;
	await recoverPiImports(agentDir);
	const receipt = readObject(join(importRoot(agentDir), "receipts", `${id}.json`));
	if (
		receipt.owner !== OWNER ||
		receipt.id !== id ||
		receipt.manifestSha256 !== id ||
		receipt.generationRelativePath !== generation ||
		!["error", "skip"].includes(String(receipt.onConflict))
	)
		throw new Error("Unknown or invalid import receipt");
	const policy = receipt.onConflict as ConflictPolicy;
	const release = acquireSettingsLock(agentDir);
	try {
		recoverLocked(agentDir);
		const manifest = validateGeneration(agentDir, generation, id);
		const baseSettingsSha256 = rawSettingsHash(agentDir);
		const settings = readObject(join(agentDir, "settings.json"));
		const merged = { ...settings };
		for (const resource of manifest.resources) {
			const path = join(agentDir, generation, resource.path);
			if (resourceConflict(agentDir, merged, resource.kind, resource.name, path)) {
				if (policy === "error") throw new Error("Activation resource conflict");
				continue;
			}
			const key = fields[resource.kind];
			const entries = merged[key];
			if (entries !== undefined && !Array.isArray(entries)) throw new Error("Invalid destination resource settings");
			const current: unknown[] = Array.isArray(entries) ? [...entries] : [];
			if (!current.some((entry) => entry === path || (isObject(entry) && entry.source === path))) current.push(path);
			merged[key] = current;
		}
		const preferences = readGenerationPreferences(agentDir, generation, manifest);
		for (const [key, value] of Object.entries(preferences)) {
			if (settings[key] !== undefined && settings[key] !== value) {
				if (policy === "error") throw new Error("Activation preference conflict");
			} else merged[key] = value;
		}
		if (JSON.stringify(merged) === JSON.stringify(settings)) return;
		const next = `${JSON.stringify(merged, null, 2)}\n`;
		const nextSettingsFile = `.pi-import-settings-${id}-${randomUUID()}.json`;
		durableWrite(join(agentDir, nextSettingsFile), next);
		const journal: ImportJournal = {
			owner: OWNER,
			operation: "activate",
			state: "settings-prepared",
			id,
			generationRelativePath: generation,
			manifestSha256: id,
			onConflict: policy,
			baseSettingsSha256,
			nextSettingsSha256: hash(next),
			nextSettingsFile,
		};
		writeJournal(agentDir, journal);
		if (rawSettingsHash(agentDir) !== baseSettingsSha256) throw new Error("Concurrent settings change detected");
		renameSync(join(agentDir, nextSettingsFile), join(agentDir, "settings.json"));
		syncDirectory(agentDir);
		journal.state = "settings-published";
		writeJournal(agentDir, journal);
		journal.state = "complete";
		writeJournal(agentDir, journal);
		rmSync(join(importRoot(agentDir), "journal.json"));
		syncDirectory(importRoot(agentDir));
	} finally {
		release();
	}
}
