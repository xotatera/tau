import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assertProbeReport, probeModularRuntime } from "./tau-extension-consumer.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));

// Clone built artifacts only; never mutate workspace modules or resolve an upstream CLI dependency.
function consumer() {
	const directory = mkdtempSync(join(tmpdir(), "tau-negative-consumer-"));
	const modules = join(directory, "node_modules");
	mkdirSync(modules);
	for (const name of readdirSync(join(repository, "node_modules"))) {
		if (name.startsWith(".")) continue;
		const source = join(repository, "node_modules", name);
		if (!name.startsWith("@")) { symlinkSync(source, join(modules, name), "junction"); continue; }
		mkdirSync(join(modules, name));
		for (const child of readdirSync(source)) {
			if (["@xotatera/tau-coding-agent", "@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"].includes(`${name}/${child}`)) continue;
			symlinkSync(join(source, child), join(modules, name, child), "junction");
		}
	}
	const host = join(modules, "@xotatera", "tau-coding-agent");
	mkdirSync(host, { recursive: true });
	const originalHost = join(repository, "packages", "coding-agent");
	cpSync(join(originalHost, "package.json"), join(host, "package.json"));
	cpSync(join(originalHost, "dist"), join(host, "dist"), { recursive: true });
	const fixture = join(directory, "legacy.ts");
	cpSync(join(originalHost, "test", "fixtures", "tau-compat", "earendil-extension.ts"), fixture);
	const home = join(directory, "home");
	mkdirSync(home);
	return { directory, host, fixture, home };
}

test("real modular probe fails when a supported legacy alias is removed", () => {
	const { directory, host, fixture, home } = consumer();
	try {
		probeModularRuntime(directory, fixture, home);
		const loaderPath = join(host, "dist", "core", "extensions", "loader.js");
		const original = readFileSync(loaderPath, "utf8");
		const changed = original.replace(/\s*"@earendil-works\/pi-coding-agent": [^\n]+,/g, "");
		assert.notEqual(changed, original, "mutation must remove the alias");
		writeFileSync(loaderPath, changed);
		assert.throws(() => probeModularRuntime(directory, fixture, home), /legacy alias resolution/);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("real modular probe rejects a fixture returning a second host implementation", () => {
	const { directory, fixture, home } = consumer();
	try {
		writeFileSync(join(directory, "second-host.ts"), "export class SessionManager {}\n");
		writeFileSync(fixture, `import { SessionManager } from "./second-host.ts";
export default function(pi) {
  pi.registerTool({ name: "compat_probe", label: "Probe", description: "Second host", parameters: {}, async execute() { return { content: [], details: { hostSessionManager: SessionManager, compiled: true, validated: true } }; } });
}
`);
		assert.throws(() => probeModularRuntime(directory, fixture, home), /duplicate host implementation/);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("bundled reports cannot silently omit registrations or host identity", () => {
	assertProbeReport({ tool: true, command: true, hostIdentity: true });
	for (const key of ["tool", "command", "hostIdentity"]) assert.throws(() => assertProbeReport({ tool: true, command: true, hostIdentity: true, [key]: false }));
	assert.throws(() => assertProbeReport({}));
});
