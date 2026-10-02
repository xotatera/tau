import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	ImportDiagnostic,
	ImportKind,
	ImportOptions,
	ImportPlan,
	ImportPreferences,
	ImportResource,
	SnapshotFile,
} from "./types.ts";

const MAX_FILES = 10_000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const builtin = new Set(builtinModules.map((name) => name.replace(/^node:/, "").split("/")[0]));
const hostPackages = new Set([
	"typebox",
	"@sinclair/typebox",
	"@xotatera/tau-coding-agent",
	...["@earendil-works", "@mariozechner"].flatMap((scope) =>
		["pi-agent-core", "pi-ai", "pi-tui", "pi-coding-agent"].map((name) => `${scope}/${name}`),
	),
]);

export function hash(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}
export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function contained(root: string, path: string): boolean {
	const part = relative(root, path);
	return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}
export function canonical(path: string): string {
	const absolute = resolve(path);
	if (existsSync(absolute)) return realpathSync(absolute);
	const parent = dirname(absolute);
	return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
}
export function settingsHash(agentDir: string): string {
	const path = join(agentDir, "settings.json");
	return existsSync(path) ? hash(readRegularFile(path)) : hash("missing");
}
export function readRegularFile(path: string, limit = MAX_METADATA_BYTES): Buffer {
	const parent = realpathSync(dirname(path));
	const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const metadata = fstatSync(descriptor);
		if (!metadata.isFile() || metadata.size > limit) throw new Error("Import file must be bounded regular data");
		if (process.platform === "linux" && !contained(parent, realpathSync(`/proc/self/fd/${descriptor}`)))
			throw new Error("Import file containment changed");
		const data = readFileSync(descriptor);
		if (data.length > limit) throw new Error("Import file exceeds size limits");
		return data;
	} finally {
		closeSync(descriptor);
	}
}
export function readObject(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	let value: unknown;
	const data = readRegularFile(path);
	try {
		value = JSON.parse(data.toString("utf8").replace(/^\uFEFF/, ""));
	} catch {
		throw new Error("Invalid import metadata JSON");
	}
	if (!isObject(value)) throw new Error("Import metadata must be an object");
	return value;
}
export function excluded(path: string): boolean {
	return path.split(/[\\/]/).some((part) => {
		const name = part.toLowerCase();
		return (
			[
				"auth.json",
				"trust.json",
				"sessions",
				"debug",
				"debug.log",
				"credentials",
				"credentials.json",
				"settings.json",
				"models.json",
				".ssh",
				".aws",
				".git",
				".npmrc",
				".netrc",
				".pypirc",
				"agents.md",
				"claude.md",
				"system.md",
				"append_system.md",
				"id_rsa",
				"id_dsa",
				"id_ecdsa",
				"id_ed25519",
			].includes(name) ||
			name === ".env" ||
			name.startsWith(".env.") ||
			/\.(pem|key|p12|pfx|jsonl|log)$/.test(name)
		);
	});
}

/** Hash only ordinary files; symlinks are materialized, never retained. No selected code is imported. */
export function resourceFiles(resource: Pick<ImportResource, "sourceRoot" | "relativePath">): SnapshotFile[] {
	const root = realpathSync(resource.sourceRoot);
	const start = resolve(root, resource.relativePath);
	if (!contained(root, start)) throw new Error("Resource path escapes its source root");
	const files: SnapshotFile[] = [];
	let total = 0;
	const ancestry = new Set<string>();
	function walk(path: string, destination: string): void {
		if (excluded(destination)) return;
		const resolved = realpathSync(path);
		if (!contained(root, resolved)) throw new Error("Resource link escapes its selected root");
		if (excluded(relative(root, resolved))) throw new Error("Resource link requires an excluded file");
		const stats = statSync(resolved);
		if (stats.isDirectory()) {
			if (ancestry.has(resolved)) throw new Error("Resource contains a link cycle");
			ancestry.add(resolved);
			for (const name of readdirSync(resolved).sort())
				walk(join(resolved, name), destination ? `${destination}/${name}` : name);
			ancestry.delete(resolved);
		} else if (stats.isFile()) {
			total += stats.size;
			if (files.length >= MAX_FILES || total > MAX_BYTES) throw new Error("Resource exceeds import size limits");
			const data = readRegularFile(resolved, MAX_BYTES);
			if (data.length !== stats.size) throw new Error("Source changed during inventory");
			files.push({ path: destination, sha256: hash(data), byteCount: data.length, mode: stats.mode & 0o777 });
		} else throw new Error("Resource contains an unsupported file kind");
	}
	walk(start, lstatSync(start).isDirectory() || statSync(start).isDirectory() ? "" : basename(start));
	return files;
}

export async function readImportPreferences(options: ImportOptions): Promise<ImportPreferences> {
	if (!options.preferences) return {};
	const settings = readObject(join(options.sourceAgentDir, "settings.json"));
	const preferences: ImportPreferences = {};
	for (const name of ["defaultProvider", "defaultModel", "defaultThinkingLevel", "theme"] as const) {
		const value = settings[name];
		if (typeof value !== "string" || !value.trim() || value.length > 256) continue;
		if (name === "defaultThinkingLevel" && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(value))
			continue;
		preferences[name] = value;
	}
	return preferences;
}

function dependencyRoot(specifier: string): string {
	return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
}
function validateDependencies(resource: ImportResource, files: SnapshotFile[]): void {
	const root = resolve(resource.sourceRoot, resource.relativePath);
	const directory = statSync(root).isDirectory() ? root : dirname(root);
	const paths = new Set(files.map((file) => file.path));
	for (const file of files) {
		const path = join(directory, file.path);
		if (basename(path) === "package.json") {
			const pkg = readObject(realpathSync(path));
			for (const section of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
				const dependencies = pkg[section];
				if (!isObject(dependencies)) continue;
				for (const dependency of Object.keys(dependencies)) {
					if (hostPackages.has(dependency)) continue;
					let parent = dirname(path);
					let found = false;
					while (contained(directory, parent)) {
						const candidate = join(parent, "node_modules", dependency, "package.json");
						if (paths.has(relative(directory, candidate).split(sep).join("/"))) {
							found = true;
							break;
						}
						if (parent === directory) break;
						parent = dirname(parent);
					}
					if (!found) throw new Error("Selected package has unavailable dependency files");
				}
			}
			const pi = pkg.pi;
			if (isObject(pi))
				for (const field of ["extensions", "skills", "prompts", "themes"]) {
					const entries = pi[field];
					if (entries === undefined) continue;
					if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string"))
						throw new Error("Unsupported package resource manifest");
					for (const entry of entries) {
						const target = resolve(dirname(path), entry);
						if (!contained(directory, target) || excluded(relative(directory, target)))
							throw new Error("Package entry requires an excluded or escaping file");
						if (!existsSync(target)) throw new Error("Package entrypoint is missing");
					}
				}
		} else if (/\.[cm]?[jt]sx?$/.test(path)) {
			const code = readRegularFile(path, MAX_BYTES).toString("utf8");
			if (/\b(?:import|require)\s*\(\s*(?![\s'"])/.test(code))
				throw new Error("Dynamic dependencies cannot be validated for this snapshot");
			for (const match of code.matchAll(/\b(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)) {
				const specifier = match[1]!;
				if (
					specifier.startsWith("node:") ||
					builtin.has(dependencyRoot(specifier)) ||
					hostPackages.has(dependencyRoot(specifier))
				)
					continue;
				if (specifier.startsWith(".")) {
					const target = resolve(dirname(path), specifier);
					if (!contained(directory, target) || excluded(relative(directory, target)))
						throw new Error("Import requires an escaping or excluded support file");
					if (
						![
							target,
							`${target}.ts`,
							`${target}.js`,
							`${target}.json`,
							join(target, "index.ts"),
							join(target, "index.js"),
						].some((candidate) => paths.has(relative(directory, candidate).split(sep).join("/")))
					)
						throw new Error("Import requires an unselected support file");
				} else {
					const dependency = dependencyRoot(specifier);
					let parent = dirname(path);
					let found = false;
					while (contained(directory, parent)) {
						if (
							paths.has(
								relative(directory, join(parent, "node_modules", dependency, "package.json"))
									.split(sep)
									.join("/"),
							)
						) {
							found = true;
							break;
						}
						if (parent === directory) break;
						parent = dirname(parent);
					}
					if (!found) throw new Error("Import requires unavailable dependency files");
				}
			}
		}
	}
}

export async function inventoryPiImport(input: ImportOptions): Promise<ImportPlan> {
	const options: ImportOptions = {
		...input,
		sourceAgentDir: canonical(input.sourceAgentDir),
		destinationAgentDir: canonical(input.destinationAgentDir),
		...(input.sourceProjectDir ? { sourceProjectDir: canonical(input.sourceProjectDir) } : {}),
		...(input.selectedIds ? { selectedIds: [...new Set(input.selectedIds)].sort() } : {}),
	};
	const diagnostics: ImportDiagnostic[] = [
		{
			code: "embedded-secrets",
			severity: "warning",
			message:
				"Known secret files are excluded; arbitrary secrets embedded in code cannot be detected. Snapshot validation is not a universal portability guarantee.",
		},
	];
	const resources: ImportResource[] = [];
	const known = new Set<string>();
	const selectedRoots = new Set<string>();
	const selected = (id: string) => options.selectedIds === undefined || options.selectedIds.includes(id);
	const error = (code: string, id: string | undefined, message: string) => {
		if (!id || selected(id)) diagnostics.push({ code, resourceId: id, severity: "error", message });
	};
	if (existsSync(join(options.destinationAgentDir, "imports", "pi", "journal.json")))
		error(
			"pending-journal",
			undefined,
			"An import journal requires recovery before an applicable plan can be reviewed.",
		);
	function add(id: string, kind: ImportKind, path: string, declaredSource?: string): void {
		known.add(id);
		if (!selected(id)) return;
		try {
			const full = resolve(path);
			const resolved = realpathSync(full);
			const directory = statSync(full).isDirectory();
			const sourceRoot = realpathSync(directory ? full : dirname(full));
			if (contained(resolved, options.destinationAgentDir) || contained(options.destinationAgentDir, resolved))
				throw new Error("Source and destination roots overlap");
			if (directory && contained(options.destinationAgentDir, canonical(sourceRoot)))
				throw new Error("Source and destination roots overlap");
			const resource: ImportResource = {
				id,
				kind,
				sourceRoot,
				relativePath: directory ? "." : basename(full),
				sha256: "",
				fileCount: 0,
				byteCount: 0,
				destinationRelativePath: `resources/${kind}/${hash(id).slice(0, 16)}${directory ? "" : `/${basename(full)}`}`,
				...(declaredSource ? { declaredSource } : {}),
			};
			if (excluded(sourceRoot) || excluded(resource.relativePath)) throw new Error("Selected resource is excluded");
			const files = resourceFiles(resource);
			if (files.length === 0) throw new Error("Selected resource has no importable files");
			validateDependencies(resource, files);
			resource.sha256 = hash(JSON.stringify(files));
			resource.fileCount = files.length;
			resource.byteCount = files.reduce((sum, file) => sum + file.byteCount, 0);
			if (kind === "package") {
				const version = readObject(join(full, "package.json")).version;
				if (typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version))
					resource.resolvedVersion = version;
			}
			const gitDir = join(sourceRoot, ".git");
			if (directory && existsSync(gitDir) && lstatSync(gitDir).isDirectory() && existsSync(join(gitDir, "HEAD"))) {
				let commit = readRegularFile(join(gitDir, "HEAD")).toString("utf8").trim();
				const ref = /^ref: (refs\/(?:heads|tags)\/[A-Za-z0-9_./-]+)$/.exec(commit)?.[1];
				if (ref && !ref.split("/").includes("..")) {
					const refPath = join(gitDir, ref);
					if (!contained(realpathSync(gitDir), canonical(refPath)))
						throw new Error("Source git reference escapes metadata root");
					if (existsSync(refPath)) commit = readRegularFile(refPath).toString("utf8").trim();
					else if (existsSync(join(gitDir, "packed-refs"))) {
						commit =
							readRegularFile(join(gitDir, "packed-refs"))
								.toString("utf8")
								.split("\n")
								.find((line) => line.split(" ")[1] === ref)
								?.split(" ")[0] ?? "";
					}
				}
				if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) resource.resolvedCommit = commit;
			}
			const identity = `${kind}:${resolve(sourceRoot, resource.relativePath)}`;
			if (!selectedRoots.has(identity)) {
				selectedRoots.add(identity);
				resources.push(resource);
			}
		} catch (cause) {
			error(
				"invalid-resource",
				id,
				cause instanceof Error &&
					/^(Resource|Source|Selected|Import requires|Dynamic dependencies|Package entry|Unsupported package)/.test(
						cause.message,
					)
					? cause.message
					: "Selected resource is unavailable or invalid",
			);
		}
	}
	for (const [scope, root] of [
		["user", options.sourceAgentDir],
		...(options.sourceProjectDir ? [["project", join(options.sourceProjectDir, ".pi")]] : []),
	] as string[][]) {
		if (!root || !scope) continue;
		if (!existsSync(root)) {
			error("missing-source", undefined, "Selected source directory is unavailable");
			continue;
		}
		if (
			contained(canonical(root), options.destinationAgentDir) ||
			contained(options.destinationAgentDir, canonical(root))
		) {
			error("overlapping-roots", undefined, "Source and destination roots overlap");
			continue;
		}
		for (const [folder, kind] of [
			["extensions", "extension"],
			["skills", "skill"],
			["prompts", "prompt"],
			["themes", "theme"],
		] as const) {
			const directory = join(root, folder);
			if (existsSync(directory))
				for (const name of readdirSync(directory).sort()) {
					if (excluded(name)) continue;
					const candidate = join(directory, name);
					let isDirectory = false;
					try {
						isDirectory = statSync(candidate).isDirectory();
					} catch {
						add(`${scope}:${kind}:${folder}/${name}`, kind, candidate);
						continue;
					}
					if (
						!isDirectory &&
						!(kind === "extension"
							? /\.(ts|js)$/.test(name)
							: kind === "theme"
								? /\.json$/.test(name)
								: /\.md$/.test(name))
					)
						continue;
					add(`${scope}:${kind}:${folder}/${name}`, kind, candidate);
				}
		}
		let settings: Record<string, unknown>;
		try {
			settings = readObject(join(root, "settings.json"));
		} catch {
			error("invalid-settings", undefined, "Source settings cannot be parsed safely");
			continue;
		}
		for (const [field, kind] of [
			["extensions", "extension"],
			["skills", "skill"],
			["prompts", "prompt"],
			["themes", "theme"],
			["packages", "package"],
		] as const) {
			const declarations = settings[field];
			if (!Array.isArray(declarations)) continue;
			for (const declaration of declarations) {
				const source =
					typeof declaration === "string"
						? declaration
						: isObject(declaration) && typeof declaration.source === "string"
							? declaration.source
							: undefined;
				if (!source || source.startsWith("builtin:") || source.startsWith("-builtin:")) continue;
				const id = `${scope}:${kind}:configured/${hash(source).slice(0, 16)}`;
				let path: string;
				if (source.startsWith("npm:")) {
					const name = source.slice(4).match(/^(@[^/]+\/[^@]+|[^@]+)(?:@.*)?$/)?.[1];
					if (!name || name.includes("..") || name.includes("\\")) {
						known.add(id);
						error("unavailable-package", id, "Installed package location is unresolved");
						continue;
					}
					path = join(root, "npm", "node_modules", name);
				} else if (source.startsWith("git:")) {
					const repository = source
						.slice(4)
						.replace(/^https?:\/\//, "")
						.split("#")[0]!;
					if (!/^[\w.-]+\/[\w.-]+\/[\w.-]+$/.test(repository) || repository.split("/").includes("..")) {
						known.add(id);
						error("unavailable-package", id, "Installed git snapshot location is unresolved");
						continue;
					}
					path = join(root, "git", repository.replace(/\.git$/, ""));
				} else path = isAbsolute(source) ? source : resolve(root, source);
				add(
					id,
					kind,
					path,
					kind === "package" && /^(npm:|git:)/.test(source) ? source.replace(/#.*/, "") : undefined,
				);
			}
		}
	}
	for (const id of options.selectedIds ?? [])
		if (!known.has(id)) error("unknown-selection", id, "Selected resource ID is unknown");
	resources.sort((left, right) => left.id.localeCompare(right.id));
	let preferences: ImportPreferences = {};
	try {
		preferences = await readImportPreferences(options);
	} catch {
		error("invalid-preferences", undefined, "Selected preferences cannot be read safely");
	}
	const baseSettingsSha256 = settingsHash(options.destinationAgentDir);
	const data = { schemaVersion: 1 as const, options, resources, diagnostics, baseSettingsSha256 };
	return {
		...data,
		id: hash(
			JSON.stringify({
				...data,
				diagnostics: diagnostics.filter((item) => item.code !== "pending-journal"),
				preferences,
			}),
		),
	};
}
