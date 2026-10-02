import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import lockfile from "proper-lockfile";
import { hash, readRegularFile } from "./inventory.ts";

export const OWNER = "tau-pi-import-v1";
export function importRoot(agentDir: string): string {
	return join(agentDir, "imports", "pi");
}
export function safeRelative(path: string): boolean {
	return (
		Boolean(path) &&
		!isAbsolute(path) &&
		!path.includes("\\") &&
		!/^[A-Za-z]:/.test(path) &&
		!path.split("/").some((part) => part === "" || part === "." || part === "..")
	);
}
export function ensureDirectory(root: string, relativePath: string): string {
	if (!safeRelative(relativePath)) throw new Error("Unsafe importer-owned directory path");
	let path = root;
	for (const part of relativePath.split("/")) {
		path = join(path, part);
		if (existsSync(path)) {
			if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
				throw new Error("Importer-owned directory is not a regular directory");
		} else mkdirSync(path, { mode: 0o700 });
	}
	return path;
}
export function syncDirectory(path: string): void {
	if (process.platform === "win32") return;
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}
export function durableWrite(path: string, data: string | Buffer, mode = 0o600): void {
	const descriptor = openSync(path, "wx", mode);
	try {
		writeFileSync(descriptor, data);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	syncDirectory(dirname(path));
}
export function atomicWrite(path: string, data: string | Buffer): void {
	const temporary = join(dirname(path), `.pi-import-write-${randomUUID()}`);
	try {
		durableWrite(temporary, data);
		renameSync(temporary, path);
		syncDirectory(dirname(path));
	} finally {
		rmSync(temporary, { force: true });
	}
}
export function rawSettingsHash(agentDir: string): string {
	const path = join(agentDir, "settings.json");
	if (!existsSync(path)) return hash("missing");
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.size > 1024 * 1024)
		throw new Error("Destination settings must be bounded regular metadata");
	return hash(readRegularFile(path));
}
export function acquireSettingsLock(agentDir: string): () => void {
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	return lockfile.lockSync(join(agentDir, "settings.json"), { realpath: false, stale: 120_000 });
}
