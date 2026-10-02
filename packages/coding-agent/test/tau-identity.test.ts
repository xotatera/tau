import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const roots: string[] = [];
const configUrl = new URL("../src/config.ts", import.meta.url).href;

interface ConfigProbe {
	app: string;
	title: string;
	package: string;
	envAgent: string;
	envSession: string;
	agent: string;
	auth: string;
	settings: string;
	sessions: string;
	assets: string;
}

function probe(overrides: Record<string, string> = {}): { root: string; value: ConfigProbe } {
	const root = mkdtempSync(join(tmpdir(), "tau-identity-"));
	roots.push(root);
	const pi = join(root, ".pi", "agent");
	mkdirSync(pi, { recursive: true });
	writeFileSync(join(pi, "auth.json"), "pi-sentinel");
	const script = join(root, "probe.mjs");
	writeFileSync(
		script,
		`import * as c from ${JSON.stringify(configUrl)};
console.log(JSON.stringify({app:c.APP_NAME,title:c.APP_TITLE,package:c.PACKAGE_NAME,
envAgent:c.ENV_AGENT_DIR,envSession:c.ENV_SESSION_DIR,agent:c.getAgentDir(),
auth:c.getAuthPath(),settings:c.getSettingsPath(),sessions:c.getSessionsDir(),assets:c.getPackageDir()}));`,
	);
	const result = spawnSync(process.execPath, [script], {
		encoding: "utf8",
		env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, ...overrides },
	});
	expect(result.status, result.stderr).toBe(0);
	expect(readFileSync(join(pi, "auth.json"), "utf8")).toBe("pi-sentinel");
	return { root, value: JSON.parse(result.stdout) as ConfigProbe };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Tau host identity and state", () => {
	test("uses Tau paths without selecting Pi state", () => {
		const { root, value } = probe();
		expect(value.app).toBe("tau");
		expect(value.title).toBe("tau");
		expect(value.package).toBe("@xotatera/tau-coding-agent");
		expect(value.auth).toBe(join(root, ".tau", "agent", "auth.json"));
		expect(value.settings).toBe(join(root, ".tau", "agent", "settings.json"));
		expect(value.sessions).toBe(join(root, ".tau", "agent", "sessions"));
	});

	test("ignores inherited Pi writable-state overrides", () => {
		const { root, value } = probe({ PI_CODING_AGENT_DIR: "/pi-state", PI_CODING_AGENT_SESSION_DIR: "/pi-sessions" });
		expect(value.agent).toBe(join(root, ".tau", "agent"));
		expect(value.envAgent).toBe("TAU_CODING_AGENT_DIR");
		expect(value.envSession).toBe("TAU_CODING_AGENT_SESSION_DIR");
	});

	test("honors an explicit Tau state override", () => {
		const { value } = probe({ TAU_CODING_AGENT_DIR: "/tau-state" });
		expect(value.agent).toBe("/tau-state");
		expect(value.auth).toBe("/tau-state/auth.json");
	});

	test("Pi asset metadata cannot change Tau identity or state roots", () => {
		const assets = mkdtempSync(join(tmpdir(), "tau-pi-assets-"));
		roots.push(assets);
		writeFileSync(
			join(assets, "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-coding-agent", piConfig: { name: "pi", configDir: ".pi" } }),
		);
		const { root, value } = probe({ PI_PACKAGE_DIR: assets });
		expect(value.assets).toBe(assets);
		expect(value.app).toBe("tau");
		expect(value.package).toBe("@xotatera/tau-coding-agent");
		expect(value.agent).toBe(join(root, ".tau", "agent"));
	});

	test("ships only the Tau executable without changing SDK or RPC entrypoints", () => {
		const metadata: unknown = JSON.parse(
			readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
		);
		expect(metadata).toMatchObject({
			name: "@xotatera/tau-coding-agent",
			bin: { tau: "dist/bundle/cli.js" },
			main: "./dist/index.js",
			exports: { "./rpc-entry": { import: "./dist/bundle/rpc-entry.js" } },
		});
		expect(metadata).not.toMatchObject({ bin: { pi: "dist/bundle/cli.js" } });
	});
});
