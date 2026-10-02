#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installCodingAgentConsumer, packReleasePackages, smokeTestCodingAgentConsumer } from "./coding-agent-consumer.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const hostName = "@xotatera/tau-coding-agent";
const fixtures = fileURLToPath(new URL("../packages/coding-agent/test/fixtures/tau-compat/", import.meta.url));

function run(args, cwd, env) {
	const result = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: 30_000 });
	if (result.status !== 0 || result.error) throw new Error(`Extension probe failed: ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`);
}

/** Both reports are required: exit zero alone cannot conceal a skipped probe. */
export function assertProbeReport(report) {
	assert.deepEqual(report, { tool: true, command: true, hostIdentity: true });
}

export function probeModularRuntime(directory, fixturePath, home) {
	const packageRoot = join(directory, "node_modules", hostName);
	const entry = join(directory, "tau-sdk-probe.mjs");
	writeFileSync(entry, `import assert from "node:assert/strict";
import { SessionManager } from "${hostName}";
import { loadExtensions } from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist/core/extensions/loader.js")).href)};
const result = await loadExtensions([${JSON.stringify(fixturePath)}], process.cwd());
assert.deepEqual(result.errors, [], "legacy alias resolution");
assert.equal(result.extensions.length, 1);
const extension = result.extensions[0];
const definition = extension.tools.get("compat_probe")?.definition;
assert.ok(definition, "compat_probe registration");
const output = await definition.execute("probe", {}, undefined, undefined, {});
assert.equal(output.details.hostSessionManager, SessionManager, "duplicate host implementation");
assert.equal(output.details.compiled, true);
assert.equal(output.details.validated, true);
assert.ok(extension.commands.has("compat-command"));
assert.ok(extension.flags.has("compat-flag"));
assert.ok(extension.shortcuts.has("ctrl+shift+j"));
assert.ok(extension.messageRenderers.has("compat-message"));
assert.ok(extension.entryRenderers.has("compat-entry"));
assert.equal(result.runtime.pendingProviderRegistrations[0]?.name, "compat-provider");
`);
	try { run([entry], directory, { PATH: process.env.PATH, HOME: home, USERPROFILE: home, PI_OFFLINE: "1", TAU_CODING_AGENT_DIR: join(home, ".tau", "agent") }); }
	finally { rmSync(entry, { force: true }); }
}

export function probeBundledRuntime(directory, fixturePath, home) {
	const packageRoot = join(directory, "node_modules", hostName);
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	const agentDir = join(home, ".tau", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "tau-probe": { baseUrl: "http://127.0.0.1:1", api: "openai-completions", models: [{ id: "probe", name: "Offline probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1024, maxTokens: 128 }] } } }));
	const probePath = join(directory, "tau-cli-probe.ts");
	const reportPath = join(directory, "tau-cli-probe.json");
	writeFileSync(probePath, `import { writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
export default function(pi) {
  pi.on("session_start", (_event, ctx) => {
    const report = {
      tool: pi.getAllTools().some(tool => tool.name === "compat_probe"),
      command: pi.getCommands().some(command => command.name === "compat-command"),
      hostIdentity: ctx.sessionManager.constructor === SessionManager,
    };
    writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(report));
    ctx.shutdown();
  });
}
`);
	try {
		run([join(packageRoot, manifest.bin.tau), "--offline", "-p", "--no-session", "-ne", "--no-builtin-tools", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--model", "tau-probe/probe", "--api-key", "probe-not-a-real-key", "-e", fixturePath, "-e", probePath], directory, { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TAU_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", AWS_EC2_METADATA_DISABLED: "true" });
		assertProbeReport(JSON.parse(readFileSync(reportPath, "utf8")));
	} finally { rmSync(probePath, { force: true }); rmSync(reportPath, { force: true }); }
}

export function smokeTestTauExtensions(directory) {
	const home = mkdtempSync(join(directory, "tau-probe-home-"));
	const source = join(directory, "synthetic-pi-source");
	const agentDir = join(home, ".tau", "agent");
	const importer = join(directory, "tau-independent-import.mjs");
	const report = join(directory, "tau-independent-import.json");
	const packageRoot = join(directory, "node_modules", hostName);
	mkdirSync(join(source, "extensions"), { recursive: true });
	for (const family of ["earendil", "mario"]) cpSync(join(fixtures, `${family}-extension.ts`), join(source, "extensions", `${family}-extension.ts`));
	writeFileSync(join(source, "auth.json"), JSON.stringify({ syntheticSecret: "never-copy-this" }));
	writeFileSync(importer, `import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inventoryPiImport, applyPiImport, activatePiImport } from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist/core/pi-import/index.js")).href)};
const source = ${JSON.stringify(source)};
const agentDir = ${JSON.stringify(agentDir)};
const plan = await inventoryPiImport({ sourceAgentDir: source, destinationAgentDir: agentDir, preferences: false, onConflict: "error" });
assert.deepEqual(plan.diagnostics.filter(item => item.severity === "error"), []);
const receipt = await applyPiImport(plan);
assert.equal(existsSync(join(agentDir, "settings.json")), false);
await activatePiImport(receipt.id, agentDir);
assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8").includes(source), false);
const paths = {};
for (const family of ["earendil", "mario"]) {
  const resource = plan.resources.find(resource => resource.relativePath === family + "-extension.ts");
  assert.ok(resource);
  const copied = join(agentDir, receipt.generationRelativePath, resource.destinationRelativePath);
  assert.deepEqual(readFileSync(copied), readFileSync(join(source, "extensions", family + "-extension.ts")));
  paths[family] = copied;
}
rmSync(source, { recursive: true });
writeFileSync(${JSON.stringify(report)}, JSON.stringify(paths));
`);
	try {
		run([importer], directory, { PATH: process.env.PATH, HOME: home, USERPROFILE: home, PI_OFFLINE: "1", TAU_CODING_AGENT_DIR: agentDir });
		const paths = JSON.parse(readFileSync(report, "utf8"));
		for (const family of ["earendil", "mario"]) {
			probeModularRuntime(directory, paths[family], home);
			probeBundledRuntime(directory, paths[family], home);
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(source, { recursive: true, force: true });
		rmSync(importer, { force: true });
		rmSync(report, { force: true });
	}
	console.log("Independent imported legacy extensions passed real modular SDK and bundled Tau CLI probes after Pi source removal.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 2) throw new Error("Usage: node scripts/tau-extension-consumer.mjs");
	const root = mkdtempSync(join(tmpdir(), "tau-extension-consumer-"));
	try {
		const tarballs = packReleasePackages(getPublicWorkspacePackages(), join(root, "tarballs"));
		const directory = join(root, "consumer");
		installCodingAgentConsumer(directory, tarballs);
		smokeTestCodingAgentConsumer(directory);
		smokeTestTauExtensions(directory);
	} finally { rmSync(root, { recursive: true, force: true }); }
}
