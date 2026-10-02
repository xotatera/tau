import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-pinned-deps.mjs", import.meta.url));

for (const [name, status] of [["@xotatera/tau-coding-agent", 0], ["@xotatera/unrelated", 1]] as const) {
	test(`dependency pin validation treats ${name} as ${status === 0 ? "workspace" : "external"}`, () => {
		const root = mkdtempSync(join(tmpdir(), "tau-pinned-"));
		try {
			writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { [name]: "^1.0.0" } }));
			const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } });
			assert.equal(result.status, status, result.stderr);
			if (status !== 0) assert.match(result.stderr, /must be pinned/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
