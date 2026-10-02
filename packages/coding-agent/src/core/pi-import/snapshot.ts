import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	canonical,
	contained,
	hash,
	inventoryPiImport,
	isObject,
	readImportPreferences,
	readObject,
	readRegularFile,
	resourceFiles,
} from "./inventory.ts";
import {
	acquireSettingsLock,
	durableWrite,
	ensureDirectory,
	OWNER,
	rawSettingsHash,
	safeRelative,
	syncDirectory,
} from "./storage.ts";
import type { GenerationManifest, ImportPlan, ImportPreferences, SnapshotFile, StagedImport } from "./types.ts";

export function generationPath(id: string): string {
	if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid import ID");
	return `imports/pi/generations/${id}`;
}
export async function reviewedPlan(plan: ImportPlan, permitPendingJournal = false): Promise<ImportPlan> {
	const fresh = await inventoryPiImport(plan.options);
	if (fresh.id !== plan.id) throw new Error("Import changed since review; obtain a new plan hash");
	if (
		fresh.diagnostics.some(
			(item) => item.severity === "error" && !(permitPendingJournal && item.code === "pending-journal"),
		)
	)
		throw new Error("Import inventory contains blocking diagnostics");
	return fresh;
}
function filePath(generation: string, resource: GenerationManifest["resources"][number], file: SnapshotFile): string {
	return resource.directory ? join(generation, resource.path, file.path) : join(generation, resource.path);
}
function assertManifest(value: unknown): asserts value is GenerationManifest {
	if (
		!isObject(value) ||
		value.schemaVersion !== 1 ||
		!Array.isArray(value.resources) ||
		!Array.isArray(value.preferenceKeys) ||
		typeof value.preferencesSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.preferencesSha256)
	)
		throw new Error("Invalid generation manifest");
	if (
		value.preferenceKeys.some(
			(key) => !["defaultProvider", "defaultModel", "defaultThinkingLevel", "theme"].includes(key),
		)
	)
		throw new Error("Invalid generation preference keys");
	for (const entry of value.resources) {
		if (
			!isObject(entry) ||
			typeof entry.id !== "string" ||
			typeof entry.kind !== "string" ||
			!["extension", "skill", "prompt", "theme", "package"].includes(entry.kind) ||
			typeof entry.name !== "string" ||
			basename(entry.name) !== entry.name ||
			typeof entry.path !== "string" ||
			!safeRelative(entry.path) ||
			!entry.path.startsWith("resources/") ||
			typeof entry.directory !== "boolean" ||
			!Array.isArray(entry.files) ||
			!entry.files.length
		)
			throw new Error("Invalid generation resource");
		if (!entry.directory && entry.files.length !== 1) throw new Error("Invalid single-file generation resource");
		for (const file of entry.files) {
			if (
				!isObject(file) ||
				typeof file.path !== "string" ||
				!safeRelative(file.path) ||
				typeof file.sha256 !== "string" ||
				!/^[a-f0-9]{64}$/.test(file.sha256) ||
				typeof file.byteCount !== "number" ||
				!Number.isSafeInteger(file.byteCount) ||
				file.byteCount < 0 ||
				typeof file.mode !== "number" ||
				!Number.isInteger(file.mode) ||
				file.mode < 0 ||
				file.mode > 0o777
			)
				throw new Error("Invalid generation file descriptor");
			if (!entry.directory && file.path !== basename(entry.path))
				throw new Error("Invalid single-file generation name");
		}
	}
}
export function validateGeneration(agentDir: string, relativePath: string, expectedHash: string): GenerationManifest {
	if (!safeRelative(relativePath) || !/^[a-f0-9]{64}$/.test(expectedHash))
		throw new Error("Invalid generation reference");
	const directory = join(agentDir, relativePath);
	if (
		!contained(canonical(agentDir), canonical(directory)) ||
		!lstatSync(directory).isDirectory() ||
		lstatSync(directory).isSymbolicLink()
	)
		throw new Error("Generation is not an owned regular directory");
	const marker = readObject(join(directory, "owner.json"));
	if (marker.owner !== OWNER || marker.manifestSha256 !== expectedHash)
		throw new Error("Generation ownership marker mismatch");
	const manifestPath = join(directory, "manifest.json");
	if (hash(readRegularFile(manifestPath)) !== expectedHash) throw new Error("Generation manifest hash mismatch");
	const manifest: unknown = readObject(manifestPath);
	assertManifest(manifest);
	const expected = new Set(["owner.json", "manifest.json", "preferences.json"]);
	for (const resource of manifest.resources)
		for (const file of resource.files) {
			const path = filePath(directory, resource, file);
			const relativePath = relative(directory, path).split(sep).join("/");
			if (!safeRelative(relativePath) || expected.has(relativePath))
				throw new Error("Duplicate or unsafe generation file");
			expected.add(relativePath);
			const stats = lstatSync(path);
			if (
				!stats.isFile() ||
				stats.nlink !== 1 ||
				stats.size !== file.byteCount ||
				(stats.mode & 0o777) !== file.mode ||
				hash(readRegularFile(path, 256 * 1024 * 1024)) !== file.sha256
			)
				throw new Error("Generation file hash or identity mismatch");
		}
	const preferencesPath = join(directory, "preferences.json");
	if (hash(readRegularFile(preferencesPath)) !== manifest.preferencesSha256)
		throw new Error("Generation preference hash mismatch");
	const actual = new Set<string>();
	function walk(path: string): void {
		const stats = lstatSync(path);
		if (stats.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
		else if (stats.isFile() && stats.nlink === 1) actual.add(relative(directory, path).split(sep).join("/"));
		else throw new Error("Generation contains a link or special file");
	}
	walk(directory);
	if (actual.size !== expected.size || [...actual].some((path) => !expected.has(path)))
		throw new Error("Generation contains unreviewed files");
	return manifest;
}

export async function describeSnapshot(
	plan: ImportPlan,
	selectedPreferences?: ImportPreferences,
): Promise<{ manifest: GenerationManifest; manifestData: string; manifestSha256: string; preferencesData: string }> {
	const preferences = { ...(selectedPreferences ?? (await readImportPreferences(plan.options))) };
	if (
		preferences.theme &&
		(isAbsolute(preferences.theme) || preferences.theme.endsWith(".json") || preferences.theme.startsWith("."))
	) {
		const sourceTheme = canonical(resolve(plan.options.sourceAgentDir, preferences.theme));
		const theme = plan.resources.find(
			(resource) =>
				resource.kind === "theme" && canonical(resolve(resource.sourceRoot, resource.relativePath)) === sourceTheme,
		);
		if (!theme) throw new Error("Import theme preference requires a selected local theme");
		const name = readObject(sourceTheme).name;
		if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/.test(name))
			throw new Error("Import theme preference has an unsupported name");
		preferences.theme = name;
	}
	const preferencesData = JSON.stringify(preferences);
	const manifest: GenerationManifest = {
		schemaVersion: 1,
		resources: [],
		preferenceKeys: Object.keys(preferences) as Array<keyof ImportPreferences>,
		preferencesSha256: hash(preferencesData),
	};
	for (const resource of plan.resources) {
		const files = resourceFiles(resource);
		if (hash(JSON.stringify(files)) !== resource.sha256) throw new Error("Source changed since review");
		manifest.resources.push({
			id: resource.id,
			kind: resource.kind,
			name: basename(resolve(resource.sourceRoot, resource.relativePath)),
			path: resource.destinationRelativePath,
			directory: resource.relativePath === ".",
			files,
		});
	}
	const manifestData = JSON.stringify(manifest);
	const manifestSha256 = hash(manifestData);
	return { manifest, manifestData, manifestSha256, preferencesData };
}

/** Caller holds the shared settings lock. The stage is marked before copying and never executes code. */
export async function stageLocked(plan: ImportPlan, selectedPreferences?: ImportPreferences): Promise<StagedImport> {
	const agentDir = plan.options.destinationAgentDir;
	if (rawSettingsHash(agentDir) !== plan.baseSettingsSha256) throw new Error("Settings changed since review");
	const { manifest, manifestData, manifestSha256, preferencesData } = await describeSnapshot(
		plan,
		selectedPreferences,
	);
	const generationRelativePath = generationPath(manifestSha256);
	const stagingRelativePath = `imports/pi/staging/${randomUUID()}`;
	const stagingDir = ensureDirectory(agentDir, stagingRelativePath);
	durableWrite(join(stagingDir, "owner.json"), JSON.stringify({ owner: OWNER, planId: plan.id, manifestSha256 }));
	try {
		for (let index = 0; index < plan.resources.length; index++) {
			const source = plan.resources[index]!;
			const resource = manifest.resources[index]!;
			const sourceDirectory =
				source.relativePath === "." ? source.sourceRoot : dirname(resolve(source.sourceRoot, source.relativePath));
			for (const file of resource.files) {
				const sourcePath = realpathSync(join(sourceDirectory, file.path));
				if (!contained(realpathSync(source.sourceRoot), sourcePath))
					throw new Error("Source link changed since review");
				const descriptor = openSync(
					sourcePath,
					constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
				);
				let data: Buffer;
				try {
					const stats = fstatSync(descriptor);
					if (!stats.isFile() || stats.size !== file.byteCount) throw new Error("Source changed since review");
					if (
						process.platform === "linux" &&
						!contained(realpathSync(source.sourceRoot), realpathSync(`/proc/self/fd/${descriptor}`))
					)
						throw new Error("Source containment changed since review");
					data = readFileSync(descriptor);
				} finally {
					closeSync(descriptor);
				}
				if (hash(data) !== file.sha256) throw new Error("Source changed since review");
				const path = filePath(stagingDir, resource, file);
				const parent = relative(stagingDir, dirname(path)).split(sep).join("/");
				if (parent) ensureDirectory(stagingDir, parent);
				const output = openSync(path, "wx", file.mode);
				try {
					writeFileSync(output, data);
					fchmodSync(output, file.mode);
					fsyncSync(output);
				} finally {
					closeSync(output);
				}
			}
		}
		durableWrite(join(stagingDir, "preferences.json"), preferencesData);
		durableWrite(join(stagingDir, "manifest.json"), manifestData);
		syncDirectory(stagingDir);
		validateGeneration(agentDir, stagingRelativePath, manifestSha256);
		await reviewedPlan(plan);
		return { planId: plan.id, stagingDir, generationRelativePath, manifestSha256 };
	} catch (error) {
		rmSync(stagingDir, { recursive: true, force: true });
		throw error;
	}
}
export async function stagePiImport(input: ImportPlan): Promise<StagedImport> {
	const plan = await reviewedPlan(input);
	const release = acquireSettingsLock(plan.options.destinationAgentDir);
	try {
		return await stageLocked(plan);
	} finally {
		release();
	}
}
