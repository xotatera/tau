import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** Only declared installed dependencies, never a whole global node_modules directory. */
export function runtimePackageClosure(installation: string): Array<{ source: string; destination: string }> {
	const result: Array<{ source: string; destination: string }> = [];
	const visited = new Set<string>();
	function visit(directory: string): void {
		const canonical = realpathSync(directory);
		result.push({ source: canonical, destination: directory });
		if (visited.has(canonical)) return;
		visited.add(canonical);
		if (visited.size > 1000) throw new Error("Runtime dependency closure exceeds limit");
		const manifest: { dependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown> } =
			JSON.parse(readFileSync(join(canonical, "package.json"), "utf8"));
		for (const name of new Set([
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.optionalDependencies ?? {}),
		])) {
			if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name) || name === "." || name === "..")
				throw new Error("Invalid runtime dependency name");
			let parent = canonical;
			let found: string | undefined;
			while (true) {
				const candidate = join(parent, "node_modules", name);
				if (existsSync(join(candidate, "package.json"))) {
					found = candidate;
					break;
				}
				if (dirname(parent) === parent) break;
				parent = dirname(parent);
			}
			if (!found) {
				if (name in (manifest.optionalDependencies ?? {})) continue;
				throw new Error(`Missing installed runtime dependency: ${name}`);
			}
			visit(found);
		}
	}
	visit(installation);
	return result;
}
