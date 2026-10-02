import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildIsolationPlan } from "../src/core/isolation/policy.ts";
import type { IsolationRequest } from "../src/core/isolation/types.ts";

describe("Tau isolation policy", () => {
	let root: string;
	let request: IsolationRequest;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tau-policy-"));
		for (const name of ["project", "agent", "install"]) mkdirSync(join(root, name));
		writeFileSync(join(root, "install", "package.json"), '{"name":"@xotatera/tau-coding-agent"}');
		writeFileSync(join(root, "install", "runtime.js"), "");
		request = {
			projectDir: join(root, "project"),
			agentDir: join(root, "agent"),
			installationDir: join(root, "install"),
			runtimeExecutable: process.execPath,
			runtimeEntry: join(root, "install", "runtime.js"),
			args: [],
			network: "on",
			explicitEnvironment: {},
		};
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});
	it("defaults network on", () => {
		const plan = buildIsolationPlan(request);
		expect(plan.network).toBe("on");
		expect(plan.argv).not.toContain("--unshare-net");
		expect(plan.argv).toContain("--unshare-pid");
	});
	it("explicit offline mode unshares networking", () => {
		expect(buildIsolationPlan({ ...request, network: "off" }).argv).toContain("--unshare-net");
	});
	it("rejects home/root/Pi overlap", () => {
		for (const projectDir of ["/", homedir()]) expect(() => buildIsolationPlan({ ...request, projectDir })).toThrow();
		mkdirSync(join(root, ".pi"));
		expect(() => buildIsolationPlan({ ...request, projectDir: join(root, ".pi") })).toThrow();
		symlinkSync(homedir(), join(root, "alias"));
		expect(() => buildIsolationPlan({ ...request, projectDir: join(root, "alias") })).toThrow();
	});
	it("does not bind the host root", () => {
		const plan = buildIsolationPlan(request);
		expect(plan.exposures.filter((item) => item.access === "read-write").map((item) => item.path)).toEqual([
			request.projectDir,
			request.agentDir,
		]);
		for (const path of ["/", homedir(), "/usr", "/usr/lib", "/run", "/etc"])
			expect(plan.exposures.map((item) => item.path)).not.toContain(path);
	});
	it("sanitizes ambient credentials and preload settings", () => {
		for (const name of ["OPENAI_API_KEY", "HTTP_PROXY", "NODE_OPTIONS", "LD_PRELOAD", "PI_CODING_AGENT_DIR"])
			vi.stubEnv(name, "synthetic-secret");
		const plan = buildIsolationPlan(request);
		expect(Object.values(plan.env)).not.toContain("synthetic-secret");
		expect(plan.env.HOME).not.toBe(homedir());
	});
	it("explicit provider/proxy variables are forwarded and redacted", () => {
		const plan = buildIsolationPlan({
			...request,
			explicitEnvironment: { OPENAI_API_KEY: "synthetic-secret", HTTP_PROXY: "http://127.0.0.1:9" },
		});
		expect(plan.env.OPENAI_API_KEY).toBe("synthetic-secret");
		expect(plan.env.HTTP_PROXY).toBe("http://127.0.0.1:9");
		expect(JSON.stringify(plan.argv)).not.toContain("synthetic-secret");
		expect(JSON.stringify(plan.exposures)).not.toContain("synthetic-secret");
	});
	it("reserved environment variables are rejected", () => {
		for (const name of [
			"HOME",
			"PATH",
			"NODE_OPTIONS",
			"LD_PRELOAD",
			"LD_LIBRARY_PATH",
			"BASH_ENV",
			"ENV",
			"PI_X",
			"TAU_X",
			"*",
			"NODE_EXTRA_CA_CERTS",
			"XDG_CONFIG_HOME",
		])
			expect(() => buildIsolationPlan({ ...request, explicitEnvironment: { [name]: "synthetic" } })).toThrow();
	});
	it("hides project Pi paths", () => {
		mkdirSync(join(request.projectDir, "nested", ".pi"), { recursive: true });
		const plan = buildIsolationPlan(request);
		const index = plan.argv.indexOf(join(request.projectDir, "nested", ".pi"));
		expect(index).toBeGreaterThan(0);
		expect(plan.argv[index - 1]).toBe("--tmpfs");
	});
	it("rejects hidden directories aliased into an allowed tree", () => {
		mkdirSync(join(request.projectDir, "private"));
		symlinkSync("private", join(request.projectDir, ".pi"));
		expect(() => buildIsolationPlan(request)).toThrow("hidden");
	});

	it("rejects a known Pi installation selected under a nonstandard name", () => {
		vi.stubEnv("PI_PACKAGE_DIR", request.projectDir);
		expect(() => buildIsolationPlan(request)).toThrow("Pi");
	});

	it("rejects npm Pi installs and their ancestors or descendants without overrides", () => {
		const npmRoot = join(root, "npm");
		const pi = join(npmRoot, "node_modules", "@earendil-works", "pi-coding-agent");
		mkdirSync(join(pi, "dist"), { recursive: true });
		writeFileSync(join(pi, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
		for (const projectDir of [pi, join(pi, "dist"), npmRoot]) {
			expect(() => buildIsolationPlan({ ...request, projectDir })).toThrow("Pi installation");
		}
	});

	it("rejects source-Pi direct reuse", () => {
		expect(() =>
			buildIsolationPlan({ ...request, args: ["-e", join(homedir(), ".pi", "agent", "extensions", "secret.ts")] }),
		).toThrow();
	});
});
