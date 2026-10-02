import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const wrapper = fileURLToPath(new URL("../tau-test.sh", import.meta.url));
const metadata = JSON.parse(readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8")) as { version: string };

for (const flag of ["--help", "--version"]) {
	test(`Tau source CLI ${flag} works outside its checkout without touching Pi state`, () => {
		const home = mkdtempSync(join(tmpdir(), "tau source # "));
		try {
			const result = spawnSync("bash", [wrapper, flag], {
				cwd: home,
				encoding: "utf8",
				env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, PI_OFFLINE: "1", PI_NO_LOCAL_LLM: "1" },
				timeout: 30_000,
			});
			assert.equal(result.status, 0, result.stderr);
			if (flag === "--version") assert.equal(result.stdout.trim(), metadata.version);
			else assert.match(result.stdout, /tau \[options\]/);
			assert.equal(existsSync(join(home, ".pi")), false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
}
