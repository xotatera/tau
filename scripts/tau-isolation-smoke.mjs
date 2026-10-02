#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventoryPiImport, applyPiImport, activatePiImport } from "../packages/coding-agent/src/core/pi-import/index.ts";

export async function smokeIsolation() {
	const root = mkdtempSync(join(tmpdir(), "tau-isolation-smoke-"));
	const home = join(root, "home"), project = join(root, "project"), agent = join(home, ".tau", "agent"), source = join(root, "synthetic-pi");
	try {
		for (const directory of [project, agent, join(source, "extensions")]) mkdirSync(directory, { recursive: true });
		cpSync(new URL("../packages/coding-agent/test/fixtures/tau-compat/earendil-extension.ts", import.meta.url), join(source, "extensions", "legacy.ts"));
		const plan = await inventoryPiImport({ sourceAgentDir: source, destinationAgentDir: agent, preferences: false, onConflict: "error" });
		assert.deepEqual(plan.diagnostics.filter(item => item.severity === "error"), []);
		const receipt = await applyPiImport(plan);
		await activatePiImport(receipt.id, agent);
		rmSync(source, { recursive: true });
		writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { probe: { baseUrl: "http://127.0.0.1:1", api: "openai-completions", models: [{ id: "probe", name: "Probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1024, maxTokens: 128 }] } } }));
		const report = join(project, "report.json");
		const probe = join(project, "probe.ts");
		writeFileSync(probe, `import { writeFileSync } from "node:fs"; import { SessionManager } from "@earendil-works/pi-coding-agent";
export default function(pi) { pi.on("session_start", (_event, ctx) => { writeFileSync(${JSON.stringify(report)}, JSON.stringify({ tool: pi.getAllTools().some(tool => tool.name === "compat_probe"), command: pi.getCommands().some(command => command.name === "compat-command"), identity: ctx.sessionManager.constructor === SessionManager })); ctx.shutdown(); }); }
`);
		for (const artifact of ["src/cli.ts", "dist/bundle/cli.js"]) for (const network of ["on", "off"]) {
			rmSync(report, { force: true });
			const entry = fileURLToPath(new URL(`../packages/coding-agent/${artifact}`, import.meta.url));
			const resolver = new URL("../packages/coding-agent/src/experimental/source-resolver.ts", import.meta.url).href;
			const args = [...(artifact.endsWith(".ts") ? ["--import", resolver] : []), entry, "--isolated", `--sandbox-network=${network}`, "--offline", "-p", "--no-session", "--no-builtin-tools", "--no-context-files", "--model", "probe/probe", "--api-key", "synthetic", "-e", probe];
			const result = spawnSync("/usr/bin/node", args, { cwd: project, env: { PATH: "/usr/bin:/bin", HOME: home, TAU_CODING_AGENT_DIR: agent }, encoding: "utf8", timeout: 15000, killSignal: "SIGKILL" });
			assert.equal(result.status, 0, result.stderr);
			assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { tool: true, command: true, identity: true });
		}
		console.log("Source and bundled isolation: imported unchanged fixture works without Pi source, network on/off.");
	} finally { rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await smokeIsolation();
