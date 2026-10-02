import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildIsolationPlan } from "../src/core/isolation/policy.ts";
import type { IsolationRequest } from "../src/core/isolation/types.ts";

// Real Linux namespace tests: missing namespaces are failures, never skips.
describe("Tau real isolation boundary", () => {
	let root: string;
	let request: IsolationRequest;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tau-boundary-"));
		for (const name of ["project", "agent", "install", "hidden"]) mkdirSync(join(root, name));
		request = {
			projectDir: join(root, "project"),
			agentDir: join(root, "agent"),
			installationDir: join(root, "install"),
			runtimeExecutable: process.execPath,
			runtimeEntry: join(root, "install", "probe.mjs"),
			args: [],
			network: "on",
			explicitEnvironment: {},
		};
		writeFileSync(join(request.installationDir, "package.json"), '{"name":"@xotatera/tau-coding-agent"}');
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	async function run(code: string, network: "on" | "off") {
		writeFileSync(request.runtimeEntry, code);
		const plan = buildIsolationPlan({ ...request, network });
		return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
			const child = spawn(plan.executable, [...plan.argv], {
				cwd: plan.cwd,
				env: plan.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "",
				stderr = "";
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
			}, 5000);
			child.stdout.on("data", (data) => {
				stdout += data;
			});
			child.stderr.on("data", (data) => {
				stderr += data;
			});
			child.on("error", reject);
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ code, stdout, stderr });
			});
		});
	}
	for (const network of ["on", "off"] as const)
		it(`allows selected writes but denies hidden source and descendants (${network})`, async () => {
			const secret = join(root, "hidden", "credential");
			writeFileSync(secret, "synthetic-secret");
			mkdirSync(join(request.projectDir, "nested", ".pi"), { recursive: true });
			writeFileSync(join(request.projectDir, "nested", ".pi", "secret"), "synthetic-secret");
			symlinkSync(secret, join(request.projectDir, "escape"));
			const code = `import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
for (const path of ${JSON.stringify([secret, join(request.projectDir, "escape"), join(request.projectDir, "nested", ".pi", "secret"), `/proc/${process.pid}/environ`])}) assert.throws(() => readFileSync(path));
assert.throws(() => writeFileSync(${JSON.stringify(secret)}, "bad"));
writeFileSync(${JSON.stringify(join(request.projectDir, "written"))}, "allowed");
writeFileSync(${JSON.stringify(join(request.agentDir, "written"))}, "allowed");
const child = spawnSync(process.execPath, ["-e", ${JSON.stringify(`require("node:fs").readFileSync(${JSON.stringify(secret)})`)}], { encoding: "utf8" });
assert.equal(child.status, 1);
console.log("boundary passed");`;
			const result = await run(code, network);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe("boundary passed");
			expect(readFileSync(secret, "utf8")).toBe("synthetic-secret");
			expect(readFileSync(join(request.projectDir, "written"), "utf8")).toBe("allowed");
		});
	it("hidden filesystem sockets cannot be reached in either network mode", async () => {
		const path = join(root, "hidden", "service.sock");
		const server = createServer((socket) => socket.end("unsafe"));
		await new Promise<void>((resolve) => server.listen(path, resolve));
		try {
			for (const network of ["on", "off"] as const) {
				const result = await run(
					`import { connect } from "node:net"; const socket = connect(${JSON.stringify(path)}); socket.on("data", data => process.stdout.write(data)); socket.on("error", () => console.log("denied"));`,
					network,
				);
				expect(result.code, result.stderr).toBe(0);
				expect(result.stdout.trim()).toBe("denied");
			}
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("abstract Unix sockets share the online namespace but not the offline namespace", async () => {
		const path = `\0tau-isolation-${process.pid}-${Date.now()}`;
		const server = createServer((socket) => socket.end("reachable"));
		await new Promise<void>((resolve) => server.listen(path, resolve));
		try {
			const code = `import { connect } from "node:net"; const socket = connect(${JSON.stringify(path)}); socket.on("data", data => process.stdout.write(data)); socket.on("error", () => console.log("denied"));`;
			expect((await run(code, "on")).stdout).toBe("reachable");
			const offline = await run(code, "off");
			expect(offline.code, offline.stderr).toBe(0);
			expect(offline.stdout.trim()).toBe("denied");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("default networking reaches loopback and explicit off denies it", async () => {
		const server = createServer((socket) => socket.end("reachable"));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing TCP address");
		try {
			const code = `import { connect } from "node:net"; const socket = connect(${address.port}, "127.0.0.1"); socket.setTimeout(500, () => socket.destroy()); socket.on("data", data => process.stdout.write(data)); socket.on("error", () => console.log("denied"));`;
			expect((await run(code, "on")).stdout).toBe("reachable");
			const offline = await run(code, "off");
			expect(offline.code, offline.stderr).toBe(0);
			expect(offline.stdout.trim()).toBe("denied");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
