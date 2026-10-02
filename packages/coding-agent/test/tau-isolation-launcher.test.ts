import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const resolver = new URL("../src/experimental/source-resolver.ts", import.meta.url).href;

describe("Tau isolation bootstrap", () => {
	let root: string;
	let agent: string;
	let marker: string;
	let extension: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tau-isolation-launcher-"));
		agent = join(root, "agent");
		marker = join(root, "project", "evaluated");
		extension = join(root, "project", "probe.ts");
		mkdirSync(agent);
		mkdirSync(join(root, "home"));
		mkdirSync(join(root, "project"));
		writeFileSync(
			extension,
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "evaluated"); export default function(pi) { pi.on("session_start", (_event, ctx) => ctx.shutdown()); }`,
		);
		writeFileSync(
			join(agent, "models.json"),
			JSON.stringify({
				providers: {
					"sandbox-probe": {
						baseUrl: "http://127.0.0.1:1",
						api: "openai-completions",
						models: [
							{
								id: "probe",
								name: "Offline bootstrap probe",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 1024,
								maxTokens: 128,
							},
						],
					},
				},
			}),
		);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function run(flags: string[], path = process.env.PATH ?? "", entry = cli) {
		return spawnSync(
			process.execPath,
			[
				"--import",
				resolver,
				entry,
				...flags,
				"--offline",
				"-p",
				"--no-session",
				"--no-builtin-tools",
				"--no-skills",
				"--no-prompt-templates",
				"--no-context-files",
				"--model",
				"sandbox-probe/probe",
				"--api-key",
				"synthetic-not-real",
				"-e",
				extension,
			],
			{
				cwd: join(root, "project"),
				env: {
					PATH: path,
					HOME: join(root, "home"),
					USERPROFILE: join(root, "home"),
					TAU_CODING_AGENT_DIR: agent,
					PI_OFFLINE: "1",
					PI_TELEMETRY: "0",
				},
				encoding: "utf8",
				timeout: 5000,
				killSignal: "SIGKILL",
			},
		);
	}

	it("unsupported platform refuses isolated mode", () => {
		const preload = join(root, "platform.mjs");
		writeFileSync(preload, 'Object.defineProperty(process, "platform", { value: "darwin" });');
		const result = spawnSync(
			process.execPath,
			["--import", preload, "--import", resolver, cli, "--isolated", "-e", extension],
			{
				cwd: join(root, "project"),
				env: { PATH: process.env.PATH, HOME: join(root, "home"), TAU_CODING_AGENT_DIR: agent },
				encoding: "utf8",
				timeout: 5000,
			},
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Linux Node");
		expect(existsSync(marker)).toBe(false);
	});

	it("Bun entry guard refuses isolation before runtime evaluation", () => {
		const runtime = join(root, "would-run.mjs");
		writeFileSync(
			runtime,
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "unsafe");`,
		);
		const guard = fileURLToPath(new URL("../src/bun/isolation-guard.ts", import.meta.url));
		const result = spawnSync(process.execPath, ["--import", guard, runtime, "--isolated"], {
			encoding: "utf8",
			timeout: 5000,
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Bun isolation is unsupported");
		expect(existsSync(marker)).toBe(false);
	});

	it("missing selected environment variables refuse startup", () => {
		const result = run(["--isolated", "--sandbox-env", "OPENAI_API_KEY"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("not set");
		expect(existsSync(marker)).toBe(false);
	});

	it("invalid network flag fails before startup", () => {
		const result = run(["--isolated", "--sandbox-network=invalid"]);
		expect(result.status).toBe(1);
		expect(existsSync(marker)).toBe(false);
	});

	it("preflight failure never evaluates extensions", () => {
		const result = run(["--isolated"], "");
		expect(result.status).toBe(1);
		expect(existsSync(marker)).toBe(false);
	});

	it("reserved environment variables are rejected before startup", () => {
		const result = run(["--isolated", "--sandbox-env", "NODE_OPTIONS"]);
		expect(result.status).toBe(1);
		expect(existsSync(marker)).toBe(false);
	});

	it("source runtime executes unchanged extensions inside isolation", () => {
		const result = run(["--isolated"]);
		expect(result.status, result.stderr).toBe(0);
		expect(existsSync(marker)).toBe(true);
	});

	it("bundled runtime executes unchanged extensions inside isolation", () => {
		const entry = fileURLToPath(new URL("../dist/bundle/cli.js", import.meta.url));
		const result = run(["--isolated"], process.env.PATH, entry);
		expect(result.status, result.stderr).toBe(0);
		expect(existsSync(marker)).toBe(true);
	});

	it("shutdown stops isolated descendants without trusted respawn", async () => {
		const heartbeat = join(root, "project", "heartbeat");
		writeFileSync(
			extension,
			`import { spawn } from "node:child_process"; export default function(pi) { pi.on("session_start", () => { spawn(process.execPath, ["-e", ${JSON.stringify(`setInterval(() => require("node:fs").writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 30);`)}], { stdio: "ignore" }); }); }`,
		);
		const child = spawn(
			process.execPath,
			[
				"--import",
				resolver,
				cli,
				"--isolated",
				"--offline",
				"-p",
				"--no-session",
				"--no-builtin-tools",
				"--no-context-files",
				"--model",
				"sandbox-probe/probe",
				"--api-key",
				"synthetic",
				"-e",
				extension,
			],
			{
				cwd: join(root, "project"),
				env: { PATH: process.env.PATH, HOME: join(root, "home"), TAU_CODING_AGENT_DIR: agent },
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		let exitCode: number | null | undefined;
		const exited = new Promise<number | null>((resolve) =>
			child.once("exit", (code) => {
				exitCode = code;
				resolve(code);
			}),
		);
		try {
			const deadline = Date.now() + 10_000;
			while (!existsSync(heartbeat) && exitCode === undefined && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 30));
			expect(existsSync(heartbeat), `Isolated child exited ${exitCode ?? "not yet"}: ${stderr}`).toBe(true);
			child.kill("SIGTERM");
			expect(await exited).toBe(143);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const stopped = readFileSync(heartbeat, "utf8");
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(readFileSync(heartbeat, "utf8")).toBe(stopped);
		} finally {
			child.kill("SIGKILL");
		}
	}, 15_000);

	it("production bash tools can list search and use git without broad system mounts", () => {
		const bashModule = new URL("../src/core/tools/bash.ts", import.meta.url).href;
		writeFileSync(
			extension,
			`import assert from "node:assert/strict"; import { writeFileSync } from "node:fs"; import { createBashTool, createLocalBashOperations } from ${JSON.stringify(bashModule)};
export default function(pi) { pi.on("session_start", async (_event, ctx) => { try {
const command = "ls; grep --version; find . -maxdepth 1; git --version; git init -q; git status --porcelain";
const result = await createBashTool(process.cwd()).execute("probe", { command, timeout: 3 });
assert.equal(result.isError, undefined); assert.equal(result.structuredContent.exit_code, 0);
let output = ""; const local = await createLocalBashOperations().exec(command, process.cwd(), { onData: data => output += data, timeout: 3 });
assert.equal(local.exitCode, 0); assert.ok(output.includes("git version"));
writeFileSync(${JSON.stringify(marker)}, "bash passed");
} catch(error) { console.error(error); process.exitCode = 1; } ctx.shutdown(); }); }`,
		);
		const result = run(["--isolated"]);
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(marker, "utf8")).toBe("bash passed");
	});

	it("trusted mode remains compatible", () => {
		const result = run([]);
		expect(result.status, result.stderr).toBe(0);
		expect(existsSync(marker)).toBe(true);
	});
});
